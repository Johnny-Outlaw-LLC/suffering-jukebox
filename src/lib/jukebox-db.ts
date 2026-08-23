// Johnny Outlaw, LLC — Suffering Jukebox — Interactive Jukebox data access.
//
// Every function here runs with the service role. Nothing in this file decides
// whether an action is allowed; that is src/lib/jukebox.ts. This file only
// reads and writes.

import { createHash, randomBytes } from "crypto";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import {
  DEFAULT_SETTINGS,
  MAX_JUKEBOX_NAME,
  MAX_JUKEBOXES_PER_ACCOUNT,
  generateCode,
  nicknameFromLyric,
  normalizeSettings,
  type JukeboxSettings,
  type PendingItem,
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
  created_at: string;
  last_live_at: string | null;
};

function hydrate(row: any): JukeboxRow {
  return { ...row, settings: normalizeSettings(row.settings) };
}

export async function getJukeboxByCode(sb: ServiceClient, code: string): Promise<JukeboxRow | null> {
  const { data, error } = await T(sb, "jukeboxes")
    .select("id,owner_email,code,name,is_live,settings,created_at,last_live_at")
    .ilike("code", code)
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data) : null;
}

export async function listJukeboxesForOwner(sb: ServiceClient, email: string): Promise<JukeboxRow[]> {
  const { data, error } = await T(sb, "jukeboxes")
    .select("id,owner_email,code,name,is_live,settings,created_at,last_live_at")
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
      .select("id,owner_email,code,name,is_live,settings,created_at,last_live_at")
      .single();
    if (!error && data) return hydrate(data);
    // 23505 is unique_violation: the code was taken, so draw another.
    if ((error as any)?.code !== "23505") throw error;
  }
  throw new Error("Could not allocate a jukebox code.");
}

export async function updateJukebox(
  sb: ServiceClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<JukeboxRow> {
  const { data, error } = await T(sb, "jukeboxes")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,owner_email,code,name,is_live,settings,created_at,last_live_at")
    .single();
  if (error) throw error;
  return hydrate(data);
}

// ── Guests ────────────────────────────────────────────────────────────────

export type GuestRow = {
  id: string;
  jukebox_id: string;
  display_name: string;
  is_banned: boolean;
  user_email: string | null;
};

const GUEST_COLS = "id,jukebox_id,display_name,is_banned,user_email";

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
    displayName: string;
    tokenHash: string;
    ip?: string | null;
    userId?: string | null;
    userEmail?: string | null;
  },
): Promise<GuestRow> {
  const { data, error } = await T(sb, "jukebox_guests")
    .insert({
      jukebox_id: opts.jukeboxId,
      display_name: opts.displayName,
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

export async function touchGuest(sb: ServiceClient, guestId: string): Promise<void> {
  await T(sb, "jukebox_guests")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", guestId);
}

export async function renameGuest(
  sb: ServiceClient,
  guestId: string,
  displayName: string,
): Promise<void> {
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

export async function listGuests(sb: ServiceClient, jukeboxId: string) {
  const { data, error } = await T(sb, "jukebox_guests")
    .select("id,display_name,is_banned,created_at,last_seen_at")
    .eq("jukebox_id", jukeboxId)
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

/**
 * A starter name lifted out of the record collection, the same trick the Save
 * Playlist modal uses. Falls back to a canned list if no lyric comes back.
 */
export async function suggestGuestName(sb: ServiceClient): Promise<string> {
  try {
    const { data } = await T(sb, "lyrics")
      .select("lyrics")
      .not("lyrics", "is", null)
      .limit(60);
    const rows = (data ?? []).filter((r: any) => (r.lyrics ?? "").length > 40);
    if (rows.length) {
      const pick = rows[Math.floor(Math.random() * rows.length)];
      return nicknameFromLyric(pick.lyrics);
    }
  } catch {
    // A nickname is not worth failing a join over.
  }
  return nicknameFromLyric(null);
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
