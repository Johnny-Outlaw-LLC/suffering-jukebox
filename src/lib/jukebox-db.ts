// Johnny Outlaw, LLC — Suffering Jukebox — Interactive Jukebox data access.
//
// Every function here runs with the service role. Nothing in this file decides
// whether an action is allowed; that is src/lib/jukebox.ts. This file only
// reads and writes.

import { createHash, randomBytes } from "crypto";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import {
  DEFAULT_SETTINGS,
  EMPTY_PLAYBACK,
  MAX_JUKEBOX_NAME,
  MAX_JUKEBOXES_PER_ACCOUNT,
  displayNameFor,
  generateCode,
  normalizePlayback,
  normalizeSettings,
  LISTENER_SESSION_GAP_MS,
  broadcastExpired,
  reconcileHostQueue,
  shapeListeners,
  type HostQueueItem,
  type Listener,
  type JukeboxSettings,
  type MirrorRow,
  type PendingItem,
  type Playback,
} from "@/lib/jukebox";

export type ServiceClient = ReturnType<typeof createSjServiceClient>;

export function sjb(): ServiceClient {
  return createSjServiceClient();
}

const T = (sb: ServiceClient, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

// ── Guest tokens ──────────────────────────────────────────────────────────
// The raw token only ever exists in the httpOnly cookie and in transit. We
// store the sha256, so a leaked database row cannot be replayed as somebody
// else's guest session.

export function issueGuestToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashGuestToken(raw) };
}

export function hashGuestToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Cookie name is per room so one browser can hold a seat in more than one. */
export function guestCookieName(code: string): string {
  return `sj_jb_${code.toUpperCase()}`;
}

// ── Rooms ─────────────────────────────────────────────────────────────────

export type JukeboxRow = {
  id: string;
  owner_email: string;
  code: string;
  name: string;
  is_live: boolean;
  settings: JukeboxSettings;
  playback: Playback;
  is_public: boolean;
  public_slug: string | null;
  /** Last broadcast running order. See LastQueueEntry. */
  last_queue: LastQueueEntry[];
  description: string | null;
  created_at: string;
  updated_at: string;
  last_live_at: string | null;
};

const JUKEBOX_SELECT =
  "id,owner_email,code,name,is_live,settings,playback,is_public,public_slug,description," +
  "last_queue,created_at,updated_at,last_live_at";

/**
 * One song in the last broadcast running order. Kept to three short keys
 * because the whole list is rewritten on the host's sync whenever the order
 * changes, and a 300 song queue should not be a 300KB write.
 */
export type LastQueueEntry = { t: string; v: string | null; by: string | null };

export function normalizeLastQueue(raw: unknown): LastQueueEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LastQueueEntry[] = [];
  for (const row of raw.slice(0, 600)) {
    const t = (row as any)?.t;
    if (typeof t !== "string" || !t) continue;
    out.push({
      t,
      v: typeof (row as any).v === "string" ? (row as any).v.slice(0, 40) : null,
      by: typeof (row as any).by === "string" ? (row as any).by.slice(0, 60) : null,
    });
  }
  return out;
}

function hydrate(row: any): JukeboxRow {
  return {
    ...row,
    settings: normalizeSettings(row.settings),
    playback: normalizePlayback(row.playback),
    last_queue: normalizeLastQueue(row.last_queue),
  };
}

export async function getJukeboxByCode(sb: ServiceClient, code: string): Promise<JukeboxRow | null> {
  const { data, error } = await T(sb, "jukeboxes")
    .select(JUKEBOX_SELECT)
    .ilike("code", code)
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data) : null;
}

/**
 * Resolve a room from whatever was in the address bar: a vanity slug, or a
 * six character code. The slug is tried FIRST on purpose — a generated code
 * could read like somebody else's chosen word, and the chosen word should win.
 */
export async function getJukeboxByKey(sb: ServiceClient, key: string): Promise<JukeboxRow | null> {
  const { data, error } = await T(sb, "jukeboxes")
    .select(JUKEBOX_SELECT)
    .ilike("public_slug", key)
    .maybeSingle();
  if (error) throw error;
  if (data) return hydrate(data);
  return getJukeboxByCode(sb, key);
}

/**
 * Every vanity address in use, for the rewrite in src/proxy.ts. Small by
 * definition: one row per host who has picked one.
 */
export async function listVanitySlugs(sb: ServiceClient): Promise<string[]> {
  const { data, error } = await T(sb, "jukeboxes")
    .select("public_slug")
    .not("public_slug", "is", null)
    .limit(2000);
  if (error) throw error;
  return (data ?? []).map((r: any) => String(r.public_slug).toLowerCase());
}

/** True when this code is already somebody's room code. */
export async function codeExists(sb: ServiceClient, code: string): Promise<boolean> {
  const { data, error } = await T(sb, "jukeboxes").select("id").ilike("code", code).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** True when this slug is already an artist page, so a room may not take it. */
export async function artistSlugExists(sb: ServiceClient, slug: string): Promise<boolean> {
  const { data, error } = await T(sb, "artists").select("id").ilike("slug", slug).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function listJukeboxesForOwner(sb: ServiceClient, email: string): Promise<JukeboxRow[]> {
  const { data, error } = await T(sb, "jukeboxes")
    .select(JUKEBOX_SELECT)
    .ilike("owner_email", email)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(hydrate);
}

/**
 * The owner's jukebox, created on first look. Capped by
 * MAX_JUKEBOXES_PER_ACCOUNT rather than a unique index, so selling more per
 * account later is a constant change and not a migration.
 */
export async function getOrCreateOwnerJukebox(
  sb: ServiceClient,
  email: string,
  displayName?: string | null,
): Promise<JukeboxRow> {
  const existing = await listJukeboxesForOwner(sb, email);
  if (existing.length >= MAX_JUKEBOXES_PER_ACCOUNT) return existing[0];

  const name = (displayName ? `${displayName}'s Jukebox` : "Jukebox").slice(0, MAX_JUKEBOX_NAME);
  // Retry on the unlikely code collision rather than trusting one draw.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode();
    const { data, error } = await T(sb, "jukeboxes")
      .insert({ owner_email: email, code, name, settings: DEFAULT_SETTINGS })
      .select(JUKEBOX_SELECT)
      .single();
    if (!error && data) return hydrate(data);
    // 23505 is unique_violation: the code was taken, so draw another.
    if ((error as any)?.code !== "23505") throw error;
  }
  throw new Error("Could not allocate a jukebox code.");
}

/**
 * Take a room off air when nothing has fed it in BROADCAST_EXPIRY_MS. Called
 * on the room resolution every route already does, so a forgotten tab cannot
 * leave a station claiming to be live for a week.
 *
 * It writes only when it actually expires, which is close to never, and it
 * clears the playback mirror on the way out for the same reason Take off air
 * does: a guest who left the page open should see the room go quiet.
 */
export async function expireStaleBroadcast(
  sb: ServiceClient,
  jukebox: JukeboxRow,
): Promise<JukeboxRow> {
  const expired = broadcastExpired({
    isLive: jukebox.is_live,
    playbackUpdatedAt: jukebox.playback.updatedAt,
    lastLiveAt: jukebox.last_live_at,
    nowMs: Date.now(),
  });
  if (!expired) return jukebox;
  try {
    return await updateJukebox(sb, jukebox.id, { is_live: false, playback: EMPTY_PLAYBACK });
  } catch {
    // Not worth failing somebody's page load over. The next request retries.
    return { ...jukebox, is_live: false };
  }
}

export async function updateJukebox(
  sb: ServiceClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<JukeboxRow> {
  const { data, error } = await T(sb, "jukeboxes")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(JUKEBOX_SELECT)
    .single();
  if (error) throw error;
  return hydrate(data);
}

// ── Guests ────────────────────────────────────────────────────────────────

export type GuestRow = {
  id: string;
  jukebox_id: string;
  /** Null until the guest types one. Render through displayNameFor(). */
  display_name: string | null;
  guest_no: number;
  is_banned: boolean;
  user_email: string | null;
  ip_address: string | null;
};

const GUEST_COLS = "id,jukebox_id,display_name,guest_no,is_banned,user_email,ip_address";

export async function getGuestByToken(
  sb: ServiceClient,
  rawToken: string | null | undefined,
  jukeboxId: string,
): Promise<GuestRow | null> {
  if (!rawToken) return null;
  const { data, error } = await T(sb, "jukebox_guests")
    .select(GUEST_COLS)
    .eq("token_hash", hashGuestToken(rawToken))
    .eq("jukebox_id", jukeboxId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createGuest(
  sb: ServiceClient,
  opts: {
    jukeboxId: string;
    /** Null when they have not named themselves; the room numbers them. */
    displayName: string | null;
    tokenHash: string;
    ip?: string | null;
    userId?: string | null;
    userEmail?: string | null;
  },
): Promise<GuestRow> {
  const { data, error } = await T(sb, "jukebox_guests")
    .insert({
      jukebox_id: opts.jukeboxId,
      display_name: opts.displayName ?? null,
      token_hash: opts.tokenHash,
      ip_address: opts.ip ?? null,
      user_id: opts.userId ?? null,
      user_email: opts.userEmail ?? null,
    })
    .select(GUEST_COLS)
    .single();
  if (error) throw error;
  return data;
}

/**
 * A guest polled, so they are still in the room. One RPC rather than a read
 * followed by a write: whether they have been away long enough to restart the
 * "listening for" clock has to be decided against the row's own last_seen_at,
 * atomically, at four requests a second per phone.
 */
export async function touchGuest(sb: ServiceClient, guestId: string): Promise<void> {
  await sb.schema(JUKEBOX_SCHEMA).rpc("touch_guest", {
    p_guest_id: guestId,
    p_gap_seconds: Math.round(LISTENER_SESSION_GAP_MS / 1000),
  });
}

export async function renameGuest(
  sb: ServiceClient,
  guestId: string,
  displayName: string,
): Promise<void> {
  // added_by_name is stored text, so a guest who names themselves after
  // queueing something has to have their waiting rows rewritten - otherwise
  // the room keeps calling them Listener 4 next to a song they just chose.
  const { error } = await T(sb, "jukebox_guests")
    .update({ display_name: displayName })
    .eq("id", guestId);
  if (error) throw error;
  // Waiting songs carry the name that shows on the TV, so they follow the
  // rename. Songs already played keep the name they were played under.
  await T(sb, "jukebox_queue")
    .update({ added_by_name: displayName })
    .eq("guest_id", guestId)
    .eq("status", "pending");
}

export async function setGuestBanned(
  sb: ServiceClient,
  guestId: string,
  banned: boolean,
): Promise<void> {
  const { error } = await T(sb, "jukebox_guests")
    .update({ is_banned: banned, banned_at: banned ? new Date().toISOString() : null })
    .eq("id", guestId);
  if (error) throw error;
}

export async function setIpBanned(
  sb: ServiceClient,
  jukeboxId: string,
  ipAddress: string,
  banned: boolean,
): Promise<void> {
  const { error } = await T(sb, "jukebox_guests")
    .update({ is_banned: banned, banned_at: banned ? new Date().toISOString() : null })
    .eq("jukebox_id", jukeboxId)
    .eq("ip_address", ipAddress);
  if (error) throw error;
}

export async function isIpBanned(
  sb: ServiceClient,
  jukeboxId: string,
  ipAddress: string,
): Promise<boolean> {
  const { data, error } = await T(sb, "jukebox_guests")
    .select("id")
    .eq("jukebox_id", jukeboxId)
    .eq("ip_address", ipAddress)
    .eq("is_banned", true)
    .limit(1);
  if (error) throw error;
  return !!data?.length;
}

export async function listGuests(sb: ServiceClient, jukeboxId: string) {
  const { data, error } = await T(sb, "jukebox_guests")
    .select("id,display_name,guest_no,is_banned,ip_address,created_at,last_seen_at,session_started_at")
    .eq("jukebox_id", jukeboxId)
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

/**
 * The people in the room right now. Everyone who has stopped polling is
 * dropped by shapeListeners(), which is where the clock comparison lives -
 * a WHERE clause here would put the same rule somewhere nobody would find it.
 */
export async function listListeners(sb: ServiceClient, jukeboxId: string): Promise<Listener[]> {
  return shapeListeners((await listGuests(sb, jukeboxId)) as any, Date.now());
}

export async function listBannedGuests(sb: ServiceClient, jukeboxId: string): Promise<Listener[]> {
  const rows = (await listGuests(sb, jukeboxId)) as any[];
  return rows.filter((r) => r.is_banned).map((r) => ({
    id: r.id,
    displayName: displayNameFor(r),
    isBanned: true,
    ipAddress: r.ip_address ?? null,
    since: null,
    lastSeenAt: r.last_seen_at,
    listeningMs: 0,
  }));
}

/**
 * Everything the room has asked for tonight, newest first.
 *
 * Keyed on added_by_owner rather than on guest_id: the question is "did
 * somebody other than the host choose this", and a guest row that has since
 * been deleted would still leave guest_id null on a song a person picked.
 *
 * One flat list rather than a map per guest. The console needs both shapes -
 * a Songs added by others box, and the songs under one name in the listeners
 * panel - and grouping a hundred rows in the browser is cheaper than running
 * the query twice.
 */
export type GuestAdd = {
  id: string;
  guestId: string | null;
  trackId: string;
  videoId: string | null;
  trackName: string;
  artistName: string | null;
  addedByName: string;
  status: string;
  createdAt: string;
};

export async function listGuestAdds(
  sb: ServiceClient,
  jukeboxId: string,
  limit = 120,
): Promise<GuestAdd[]> {
  const { data, error } = await T(sb, "jukebox_queue")
    .select(
      "id,guest_id,track_id,video_id,added_by_name,status,created_at," +
        "tracks!inner(name,albums!inner(artists!inner(name)))",
    )
    .eq("jukebox_id", jukeboxId)
    .eq("added_by_owner", false)
    // Removed rows are left out on purpose: the host can put one of these back
    // in the queue by clicking it, and a row the room has dropped would be
    // swept straight back out again by the next sync.
    .in("status", ["pending", "playing", "played"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    guestId: r.guest_id,
    trackId: r.track_id,
    videoId: r.video_id,
    trackName: r.tracks?.name ?? "Unknown",
    artistName: r.tracks?.albums?.artists?.name ?? null,
    addedByName: r.added_by_name,
    status: r.status,
    createdAt: r.created_at,
  }));
}

// ── Queue ─────────────────────────────────────────────────────────────────

export type QueueItem = {
  id: string;
  trackId: string;
  videoId: string | null;
  guestId: string | null;
  addedByName: string;
  addedByOwner: boolean;
  sort: number;
  status: string;
  createdAt: string;
  trackName: string;
  albumName: string | null;
  albumArt: string | null;
  artistName: string | null;
  artistSlug: string | null;
  durationMs: number | null;
};

const QUEUE_SELECT =
  "id,track_id,video_id,guest_id,added_by_name,added_by_owner,sort,status,created_at," +
  "tracks!inner(name,duration_ms,explicit,albums!inner(name,art_url,artists!inner(name,slug)))";

function shapeQueueRow(r: any): QueueItem {
  const track = r.tracks ?? {};
  const album = track.albums ?? {};
  const artist = album.artists ?? {};
  return {
    id: r.id,
    trackId: r.track_id,
    videoId: r.video_id,
    guestId: r.guest_id,
    addedByName: r.added_by_name,
    addedByOwner: r.added_by_owner,
    sort: Number(r.sort),
    status: r.status,
    createdAt: r.created_at,
    trackName: track.name ?? "Unknown",
    albumName: album.name ?? null,
    albumArt: album.art_url ?? null,
    artistName: artist.name ?? null,
    artistSlug: artist.slug ?? null,
    durationMs: track.duration_ms ?? null,
  };
}

/** Waiting and playing songs, in play order. */
export async function loadQueue(sb: ServiceClient, jukeboxId: string): Promise<QueueItem[]> {
  const { data, error } = await T(sb, "jukebox_queue")
    .select(QUEUE_SELECT)
    .eq("jukebox_id", jukeboxId)
    .in("status", ["pending", "playing"])
    .order("status", { ascending: false }) // 'playing' sorts before 'pending'
    .order("sort", { ascending: true })
    .limit(600);
  if (error) throw error;
  return (data ?? []).map(shapeQueueRow);
}

export async function loadRecentlyPlayed(
  sb: ServiceClient,
  jukeboxId: string,
  limit = 20,
): Promise<QueueItem[]> {
  const { data, error } = await T(sb, "jukebox_queue")
    .select(QUEUE_SELECT)
    .eq("jukebox_id", jukeboxId)
    .eq("status", "played")
    .order("played_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(shapeQueueRow);
}

/** The lightweight shape the add rule needs — no joins, no track metadata. */
export async function loadPending(sb: ServiceClient, jukeboxId: string): Promise<PendingItem[]> {
  const { data, error } = await T(sb, "jukebox_queue")
    .select("id,sort,guest_id,track_id")
    .eq("jukebox_id", jukeboxId)
    .in("status", ["pending", "playing"])
    .order("sort", { ascending: true })
    .limit(600);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    id: r.id,
    sort: Number(r.sort),
    guestId: r.guest_id,
    trackId: r.track_id,
  }));
}

export async function getTrackForQueue(sb: ServiceClient, trackId: string) {
  const { data, error } = await T(sb, "tracks")
    .select("id,name,explicit,albums!inner(name,artists!inner(name))")
    .eq("id", trackId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const album: any = (data as any).albums ?? {};
  return {
    id: (data as any).id as string,
    name: (data as any).name as string,
    explicit: !!(data as any).explicit,
    albumName: (album.name ?? null) as string | null,
    artistName: (album.artists?.name ?? null) as string | null,
  };
}

export async function insertQueueItem(
  sb: ServiceClient,
  row: {
    jukeboxId: string;
    trackId: string;
    videoId: string | null;
    guestId: string | null;
    addedByName: string;
    addedByOwner: boolean;
    sort: number;
  },
): Promise<QueueItem> {
  const { data, error } = await T(sb, "jukebox_queue")
    .insert({
      jukebox_id: row.jukeboxId,
      track_id: row.trackId,
      video_id: row.videoId,
      guest_id: row.guestId,
      added_by_name: row.addedByName,
      added_by_owner: row.addedByOwner,
      sort: row.sort,
    })
    .select(QUEUE_SELECT)
    .single();
  if (error) throw error;
  return shapeQueueRow(data);
}

export async function getQueueItem(sb: ServiceClient, itemId: string, jukeboxId: string) {
  const { data, error } = await T(sb, "jukebox_queue")
    .select("id,jukebox_id,guest_id,status,sort,track_id")
    .eq("id", itemId)
    .eq("jukebox_id", jukeboxId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function removeQueueItem(
  sb: ServiceClient,
  itemId: string,
  removedBy: string,
): Promise<void> {
  // Soft delete: the row stays so the owner can see who queued what, and so a
  // ban can sweep a guest's songs without losing the history.
  const { error } = await T(sb, "jukebox_queue")
    .update({ status: "removed", removed_at: new Date().toISOString(), removed_by: removedBy })
    .eq("id", itemId);
  if (error) throw error;
}

export async function removeAllForGuest(
  sb: ServiceClient,
  jukeboxId: string,
  guestId: string,
  removedBy: string,
): Promise<number> {
  const { data, error } = await T(sb, "jukebox_queue")
    .update({ status: "removed", removed_at: new Date().toISOString(), removed_by: removedBy })
    .eq("jukebox_id", jukeboxId)
    .eq("guest_id", guestId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

export async function clearQueue(
  sb: ServiceClient,
  jukeboxId: string,
  removedBy: string,
): Promise<number> {
  const { data, error } = await T(sb, "jukebox_queue")
    .update({ status: "removed", removed_at: new Date().toISOString(), removed_by: removedBy })
    .eq("jukebox_id", jukeboxId)
    .in("status", ["pending", "playing"])
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

export async function setQueueItemSort(sb: ServiceClient, itemId: string, sort: number) {
  const { error } = await T(sb, "jukebox_queue").update({ sort }).eq("id", itemId);
  if (error) throw error;
}

/**
 * Mark one item as the song now playing. Anything previously playing in the
 * same room is retired to 'played' first, so the room can only ever have one.
 */
export async function markPlaying(sb: ServiceClient, jukeboxId: string, itemId: string) {
  const now = new Date().toISOString();
  await T(sb, "jukebox_queue")
    .update({ status: "played", played_at: now })
    .eq("jukebox_id", jukeboxId)
    .eq("status", "playing");
  const { error } = await T(sb, "jukebox_queue")
    .update({ status: "playing" })
    .eq("id", itemId)
    .eq("jukebox_id", jukeboxId);
  if (error) throw error;
}

export async function markPlayed(sb: ServiceClient, jukeboxId: string, itemId: string) {
  const { error } = await T(sb, "jukebox_queue")
    .update({ status: "played", played_at: new Date().toISOString() })
    .eq("id", itemId)
    .eq("jukebox_id", jukeboxId);
  if (error) throw error;
}

// ── The host mirror ───────────────────────────────────────────────────────
// The room's queue is the host's own player queue, seen from the outside.
// syncHostQueue() takes a snapshot of what the host is holding and makes the
// room agree with it, then reports back the guest adds the host has not seen
// so it can append them and toast them.

export type HostSyncResult = {
  /** Room rows created for songs the host had queued locally. */
  assigned: { index: number; itemId: string }[];
  /** Guest adds. Full queue rows so the host can play and announce them. */
  adopted: QueueItem[];
  /** Room rows the host still lists that have since been removed. */
  dropped: string[];
  removed: number;
};

export async function syncHostQueue(
  sb: ServiceClient,
  jukeboxId: string,
  opts: {
    items: HostQueueItem[];
    currentIndex: number;
    snapshotAtMs: number;
    ownerName: string;
    /** What the room already has stored, so an unchanged order writes nothing. */
    lastQueue: LastQueueEntry[];
  },
): Promise<HostSyncResult> {
  const cols = "id,track_id,status,sort,created_at";

  const { data: active, error: activeErr } = await T(sb, "jukebox_queue")
    .select(cols)
    .eq("jukebox_id", jukeboxId)
    .in("status", ["pending", "playing"])
    .limit(600);
  if (activeErr) throw activeErr;

  // Rows the snapshot claims but which are no longer waiting: already played,
  // or removed out from under the host. Without these the reconcile would see
  // an unclaimed item and insert a duplicate of a song already in the room.
  const claimIds = opts.items.map((i) => i.itemId).filter(Boolean) as string[];
  const known = new Set((active ?? []).map((r: any) => r.id));
  const missing = claimIds.filter((id) => !known.has(id));
  let extra: any[] = [];
  if (missing.length) {
    const { data, error } = await T(sb, "jukebox_queue")
      .select(cols)
      .eq("jukebox_id", jukeboxId)
      .in("id", missing.slice(0, 600));
    if (error) throw error;
    extra = data ?? [];
  }

  const toMirror = (r: any): MirrorRow => ({
    id: r.id,
    trackId: r.track_id,
    status: r.status,
    sort: Number(r.sort),
    createdAt: Date.parse(r.created_at),
  });

  const plan = reconcileHostQueue({
    items: opts.items,
    currentIndex: opts.currentIndex,
    existing: [...(active ?? []), ...extra].map(toMirror),
    snapshotAtMs: opts.snapshotAtMs,
  });

  const assigned: { index: number; itemId: string }[] = [];
  if (plan.insert.length) {
    const { data, error } = await T(sb, "jukebox_queue")
      .insert(
        plan.insert.map((row) => ({
          jukebox_id: jukeboxId,
          track_id: row.trackId,
          video_id: row.videoId,
          guest_id: null,
          added_by_name: opts.ownerName,
          added_by_owner: true,
          sort: row.sort,
          status: row.status,
          ...(row.status === "played" ? { played_at: new Date().toISOString() } : {}),
        })),
      )
      .select("id,sort");
    if (error) throw error;
    // Matched by sort, not by the order the insert came back in: sort is
    // (index + 1) * step, so it is unique across the snapshot by construction.
    const bySort = new Map((data ?? []).map((r: any) => [Number(r.sort), r.id as string]));
    for (const row of plan.insert) {
      const id = bySort.get(row.sort);
      if (id) assigned.push({ index: row.index, itemId: id });
    }
  }

  // Grouped by the value being written, so a track change is two statements
  // rather than one per row in the queue.
  const groups = new Map<string, string[]>();
  for (const u of plan.update) {
    const key = `${u.sort}|${u.status}`;
    groups.set(key, [...(groups.get(key) ?? []), u.id]);
  }
  for (const [key, ids] of groups) {
    const [sortRaw, status] = key.split("|");
    await T(sb, "jukebox_queue")
      .update({
        sort: Number(sortRaw),
        status,
        ...(status === "played" ? { played_at: new Date().toISOString() } : {}),
      })
      .in("id", ids);
  }

  if (plan.remove.length) {
    await T(sb, "jukebox_queue")
      .update({ status: "removed", removed_at: new Date().toISOString(), removed_by: "host:sync" })
      .in("id", plan.remove);
  }

  let adopted: QueueItem[] = [];
  if (plan.adopt.length) {
    const { data, error } = await T(sb, "jukebox_queue")
      .select(QUEUE_SELECT)
      .in("id", plan.adopt)
      .order("sort", { ascending: true });
    if (error) throw error;
    adopted = (data ?? []).map(shapeQueueRow);
  }

  // The running order, kept for the night the host closes the laptop. Written
  // only when it actually changes, so a host pushing the same queue every five
  // seconds writes nothing at all.
  const lastQueue: LastQueueEntry[] = opts.items
    .filter((i) => !!i.trackId)
    .map((i) => ({ t: i.trackId as string, v: i.videoId ?? null, by: i.addedBy ?? null }));
  if (lastQueue.length && !sameLastQueue(lastQueue, opts.lastQueue)) {
    await T(sb, "jukeboxes").update({ last_queue: lastQueue }).eq("id", jukeboxId);
  }

  return { assigned, adopted, dropped: plan.drop, removed: plan.remove.length };
}

function sameLastQueue(a: LastQueueEntry[], b: LastQueueEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].t !== b[i].t || a[i].v !== b[i].v || a[i].by !== b[i].by) return false;
  }
  return true;
}

/**
 * The last playlist that was actually on air, hydrated into something a
 * visitor can play on their own machine. Read from jukeboxes.last_queue rather
 * than rebuilt from jukebox_queue: rows played on an earlier night keep their
 * 'played' status and a stale sort, so the table cannot tell you tonight's
 * order on its own.
 *
 * A stored video id is preferred, because it is the upload the host was
 * actually playing, alternates and all. Where there is none we fall back to
 * the track's primary version.
 */
export type OfflineTrack = {
  trackId: string;
  videoId: string | null;
  trackName: string;
  artistName: string | null;
  albumName: string | null;
  albumArt: string | null;
  addedByName: string | null;
};

export async function loadLastSyncedPlaylist(
  sb: ServiceClient,
  jukebox: JukeboxRow,
): Promise<OfflineTrack[]> {
  const entries = jukebox.last_queue;
  if (!entries.length) return [];
  const ids = Array.from(new Set(entries.map((e) => e.t)));

  const [metaRes, videoRes] = await Promise.all([
    T(sb, "tracks")
      .select("id,name,albums!inner(name,art_url,artists!inner(name))")
      .in("id", ids),
    T(sb, "track_videos")
      .select("track_id,video_id,is_primary,is_playable,view_count")
      .in("track_id", ids)
      .eq("is_playable", true),
  ]);
  if (metaRes.error) throw metaRes.error;
  if (videoRes.error) throw videoRes.error;

  const meta = new Map<string, any>((metaRes.data ?? []).map((r: any) => [r.id, r]));
  // Primary first, then most-viewed: the same order of preference the player
  // itself uses, so the offline list plays the upload the room would have got.
  const best = new Map<string, string>();
  const ranked = ((videoRes.data ?? []) as any[]).slice().sort((a, b) => {
    if (!!a.is_primary !== !!b.is_primary) return a.is_primary ? -1 : 1;
    return Number(b.view_count ?? 0) - Number(a.view_count ?? 0);
  });
  for (const row of ranked) {
    if (!best.has(row.track_id)) best.set(row.track_id, row.video_id);
  }

  return entries.map((e) => {
    const m = meta.get(e.t);
    const album = m?.albums ?? {};
    return {
      trackId: e.t,
      videoId: e.v ?? best.get(e.t) ?? null,
      trackName: m?.name ?? "Unknown",
      artistName: album.artists?.name ?? null,
      albumName: album.name ?? null,
      albumArt: album.art_url ?? null,
      addedByName: e.by,
    };
  });
}

/**
 * Where the host's player is, written straight onto the room. Guests read this
 * and extrapolate from updatedAt, which is why the timestamp is stamped here
 * on the server rather than taken from whatever clock the host's laptop has.
 */
export async function setPlayback(
  sb: ServiceClient,
  jukeboxId: string,
  playback: Playback,
): Promise<Playback> {
  const stamped = normalizePlayback({ ...playback, updatedAt: new Date().toISOString() });
  const { error } = await T(sb, "jukeboxes").update({ playback: stamped }).eq("id", jukeboxId);
  if (error) throw error;
  return stamped;
}

/** Plain and LRC lyrics for one track, plus the version's own intro offset. */
export async function loadTrackLyrics(sb: ServiceClient, trackId: string) {
  const [plainRes, syncRes] = await Promise.all([
    T(sb, "lyrics").select("lyrics").eq("track_id", trackId).maybeSingle(),
    T(sb, "tracks").select("lyrics_synced").eq("id", trackId).maybeSingle(),
  ]);
  return {
    plain: ((plainRes.data as any)?.lyrics ?? null) as string | null,
    synced: ((syncRes.data as any)?.lyrics_synced ?? null) as string | null,
  };
}
