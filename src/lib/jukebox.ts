// Johnny Outlaw, LLC — Suffering Jukebox — Interactive Jukebox domain layer.
//
// Pure rules, no I/O. Everything that decides whether an action is allowed
// lives here so the guest app, the host console and the API routes cannot
// disagree with each other. If you are about to write `if (settings.` in a
// route handler, write it in this file instead.

/**
 * Four things used to be settings and are now simply how the jukebox works,
 * because every one of them had an answer the host would always give:
 *
 *   - adding while off air: never. A song queued into a room nobody is
 *     playing is a request nobody hears.
 *   - the same song twice: never. It is a queue, not a repeat button.
 *   - explicit tracks: always allowed. This is a record collection.
 *   - round robin: gone with the Order control. The per-guest cap is what
 *     stops one person stacking the queue, and it does it without anybody
 *     having to understand what "take turns between guests" means.
 *
 * A setting nobody changes is a question nobody wanted asked.
 */
export type JukeboxSettings = {
  /** Songs a single guest may have waiting at once. 0 = unlimited. */
  maxPendingPerGuest: number;
  /** Signed-in guests may import a missing YouTube song into the catalogue. */
  allowGuestImports: boolean;
  /**
   * A song somebody in the room asked for goes in front of the host's own
   * list rather than behind all of it. On a night with a long playlist loaded
   * this is the difference between a request being heard and being heard
   * tomorrow.
   */
  guestsFirst: boolean;
};

export const DEFAULT_SETTINGS: JukeboxSettings = {
  maxPendingPerGuest: 3,
  allowGuestImports: false,
  guestsFirst: false,
};

/**
 * One jukebox per account today. The plan is to sell more per account later,
 * so this is a constant rather than a unique index on owner_email — raising
 * the limit is a one-line change with no migration.
 */
export const MAX_JUKEBOXES_PER_ACCOUNT = 1;

export const MAX_DISPLAY_NAME = 40;
export const MAX_JUKEBOX_NAME = 60;
/** Hard ceiling on a single room's waiting list, to stop runaway inserts. */
export const MAX_PENDING_TOTAL = 500;

export function normalizeSettings(raw: unknown): JukeboxSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const int = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.round(n), min), max);
  };
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : fallback;
  // Keys that are no longer settings are simply not read. Stored blobs still
  // carry them; ignoring them is the whole migration.
  return {
    maxPendingPerGuest: int(s.maxPendingPerGuest, DEFAULT_SETTINGS.maxPendingPerGuest, 0, 50),
    allowGuestImports: bool(s.allowGuestImports, DEFAULT_SETTINGS.allowGuestImports),
    guestsFirst: bool(s.guestsFirst, DEFAULT_SETTINGS.guestsFirst),
  };
}

// ── Room codes ────────────────────────────────────────────────────────────
// No 0/O/1/I/L: the code gets printed on a table card and read aloud across a
// noisy bar, so the alphabet has to survive both.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

export function generateCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

// ── Vanity addresses ──────────────────────────────────────────────────────
// A room code is six characters shouted across a bar. A vanity slug is what
// goes on the poster: sufferingjukebox.stream/outlaw. Both resolve to the same
// room, and the slug is tried FIRST — a generated code could in principle read
// like somebody else's chosen word, and the chosen word should win.

/**
 * Single-segment paths the app already owns. A jukebox slug that matched one
 * of these would shadow a real page, so they are refused at the point the
 * owner picks a name rather than left to fight it out in the router.
 */
export const RESERVED_SLUGS = new Set([
  "about", "account", "admin", "api", "artist", "artists", "artist-agreement",
  "artist-rights-admin", "artist-upload", "assets", "auth", "album", "albums",
  "blog", "community", "contact", "cookies", "dmca", "embed", "explore",
  "faq", "favicon", "feed", "help", "home", "images", "img", "index", "j",
  "join", "jukebox", "jukeboxes", "legal", "live", "login", "logout", "me",
  "new", "news", "oembed", "playlist", "playlists", "pricing", "privacy",
  "qr", "queue", "robots", "rss", "s", "search", "settings", "share",
  "share-image", "signin", "signout", "signup", "sitemap", "song", "songs",
  "static", "support", "terms", "track", "tracks", "well-known",
]);

export const MIN_SLUG = 3;
export const MAX_SLUG = 32;

export type SlugResult = { ok: true; slug: string } | { ok: false; message: string };

/**
 * Fold whatever the owner typed into a URL-safe slug, or explain why it cannot
 * be one. Deliberately strict: this string is read aloud and typed by hand.
 */
export function normalizeVanitySlug(input: unknown): SlugResult {
  if (typeof input !== "string") return { ok: false, message: "Type a web address." };
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length < MIN_SLUG) {
    return { ok: false, message: `Use at least ${MIN_SLUG} letters or numbers.` };
  }
  if (slug.length > MAX_SLUG) {
    return { ok: false, message: `Keep it to ${MAX_SLUG} characters or fewer.` };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, message: `"${slug}" is a page on this site already. Pick another.` };
  }
  return { ok: true, slug };
}

/**
 * What /j/<x> and the vanity rewrite both accept: a room code, or a slug.
 * Kept looser than normalizeCode on purpose — deciding which one it is happens
 * against the database, not against the shape of the string.
 */
export function normalizeRoomKey(input: string): string | null {
  const key = (input ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9-]{3,40}$/.test(key)) return null;
  return key;
}

// ── Playback mirror ───────────────────────────────────────────────────────
// What the host player is doing, as the guests need to hear it. One blob for
// the same reason settings is one blob: adding a field should not need a
// migration.

export type Playback = {
  /** The YouTube upload actually on screen, which may be an alternate version. */
  videoId: string | null;
  trackId: string | null;
  /** The room's queue row this is playing, so the guest list can highlight it. */
  itemId: string | null;
  title: string | null;
  artistName: string | null;
  /** Where the host was, at updatedAt. Guests extrapolate from there. */
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  /**
   * Per-video lyric offset, carried here so a guest does not need the
   * track_videos table to line the karaoke up.
   */
  lyricOffsetMs: number;
  /** Server clock when this was written. The only time base guests trust. */
  updatedAt: string | null;
};

export const EMPTY_PLAYBACK: Playback = {
  videoId: null,
  trackId: null,
  itemId: null,
  title: null,
  artistName: null,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
  lyricOffsetMs: 0,
  updatedAt: null,
};

export function normalizePlayback(raw: unknown): Playback {
  const p = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const ms = (v: unknown, max: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.round(n), max);
  };
  return {
    videoId: str(p.videoId, 40),
    trackId: str(p.trackId, 40),
    itemId: str(p.itemId, 40),
    title: str(p.title, 200),
    artistName: str(p.artistName, 120),
    // Six hours caps a stuck client writing nonsense; nothing here is that long.
    positionMs: ms(p.positionMs, 6 * 60 * 60 * 1000),
    durationMs: ms(p.durationMs, 6 * 60 * 60 * 1000),
    isPlaying: p.isPlaying === true,
    lyricOffsetMs: ms(p.lyricOffsetMs, 30 * 60 * 1000),
    updatedAt: str(p.updatedAt, 40),
  };
}

/**
 * Where the host is *now*, given what they last reported and how long ago that
 * was. This is the whole trick behind a guest phone staying in step with the
 * TV between five-second polls: the position is extrapolated locally and only
 * corrected when it drifts.
 */
export function projectedPositionMs(
  playback: Playback,
  /** Milliseconds elapsed since playback.updatedAt, by the caller's clock. */
  elapsedMs: number,
): number {
  if (!playback.isPlaying) return playback.positionMs;
  const at = playback.positionMs + Math.max(0, elapsedMs);
  if (playback.durationMs > 0) return Math.min(at, playback.durationMs);
  return at;
}

/**
 * How long a room may go with nothing being played into it before it stops
 * counting as on air.
 *
 * Six hours rather than the two minutes the guest stage uses, because these
 * are different questions. The stage asks "is the mirror worth watching right
 * now"; this asks "has somebody left a station advertising itself as live and
 * walked away". A host who puts the jukebox on air at six and starts the music
 * at ten has done nothing wrong, and must not be shut off in between.
 */
export const BROADCAST_EXPIRY_MS = 6 * 60 * 60 * 1000;

/**
 * True when a room claims to be live but nothing has fed it in far too long.
 * Measured from the LATER of the last playback write and the moment it went on
 * air, so the gap between opening the room and starting the music is not
 * mistaken for silence.
 */
export function broadcastExpired(opts: {
  isLive: boolean;
  playbackUpdatedAt: string | null;
  lastLiveAt: string | null;
  nowMs: number;
}): boolean {
  if (!opts.isLive) return false;
  const played = opts.playbackUpdatedAt ? Date.parse(opts.playbackUpdatedAt) : NaN;
  const opened = opts.lastLiveAt ? Date.parse(opts.lastLiveAt) : NaN;
  const candidates = [played, opened].filter((n) => Number.isFinite(n)) as number[];
  // No stamp at all is a room from before any of this existed. Leave it alone
  // rather than switching off something we cannot date.
  if (!candidates.length) return false;
  return opts.nowMs - Math.max(...candidates) > BROADCAST_EXPIRY_MS;
}

export function normalizeCode(input: string): string | null {
  const c = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === CODE_LENGTH ? c : null;
}

// ── Guest names ────────────────────────────────────────────────────
// A guest types their own name or does without one. See displayNameFor().

export function sanitizeDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // Collapse whitespace and strip control characters so a name cannot break
  // the TV layout. Content is deliberately unfiltered otherwise — the owner
  // has a ban button, which is a better tool than a word list.
  const name = input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return null;
  return name.slice(0, MAX_DISPLAY_NAME);
}

// ── Listeners ───────────────────────────────────────────────────────
// A guest row is permanent — a bar regular's is weeks old. A LISTENER is a
// guest whose phone is still polling right now, and the thing the host wants
// on screen is how long they have been standing there, which is measured from
// the top of the current stretch and not from the night they first scanned.

/** A guest polls every four seconds. Miss a handful and they have walked off. */
export const LISTENER_ACTIVE_MS = 45_000;

/**
 * Away longer than this and the "listening for" clock starts again. Short
 * enough that yesterday's session never bleeds into tonight's, long enough
 * that a phone locking during a song does not reset it.
 */
export const LISTENER_SESSION_GAP_MS = 5 * 60_000;

export type ListenerRow = {
  id: string;
  display_name: string | null;
  guest_no: number;
  is_banned: boolean;
  ip_address?: string | null;
  created_at: string;
  last_seen_at: string;
  session_started_at?: string | null;
};

export type Listener = {
  id: string;
  displayName: string;
  isBanned: boolean;
  ipAddress: string | null;
  /** ISO, top of the current stretch. */
  since: string | null;
  lastSeenAt: string;
  /** How long this stretch has run, by the server's clock. */
  listeningMs: number;
};

/**
 * The people in the room right now, longest-standing first.
 *
 * Anybody who has stopped polling is dropped outright rather than greyed out.
 * A guest row is permanent, so a list that kept them turned into every phone
 * that had ever scanned the code - a panel headed "0 listening" above eight
 * names, which is worse than useless. Who queued what is still on the queue
 * rows themselves; this answers a different question, and only that one.
 */
export function shapeListeners(rows: ListenerRow[], nowMs: number): Listener[] {
  const out: Listener[] = [];
  for (const r of rows) {
    const seenAt = Date.parse(r.last_seen_at);
    if (!Number.isFinite(seenAt) || nowMs - seenAt >= LISTENER_ACTIVE_MS) continue;
    const startedAt = Date.parse(r.session_started_at ?? r.created_at);
    out.push({
      id: r.id,
      displayName: displayNameFor(r),
      isBanned: r.is_banned,
      ipAddress: r.ip_address ?? null,
      since: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
      lastSeenAt: r.last_seen_at,
      listeningMs: Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : 0,
    });
  }
  out.sort((a, b) => b.listeningMs - a.listeningMs);
  return out;
}

/**
 * What the room calls somebody. Their own name if they typed one, and their
 * join number if they have not.
 *
 * Names are never invented. Guests used to be given one lifted out of a lyric
 * and it read as a bug, not a joke: nobody could tell whether the room was
 * full of strangers with odd names or whether the app had made them up.
 */
export function displayNameFor(guest: {
  display_name?: string | null;
  guest_no?: number | null;
}): string {
  const chosen = (guest.display_name ?? "").trim();
  if (chosen) return chosen;
  return `Listener ${guest.guest_no ?? 1}`;
}

/** "1h 12m", "9m", "just arrived" — the only format the panel needs. */
export function formatListeningFor(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just arrived";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hrs}h ${rest}m` : `${hrs}h`;
}

// ── Queue ordering ────────────────────────────────────────────────────────

export type PendingItem = {
  id: string;
  sort: number;
  /** Guest id, or null for anything the owner queued themselves. */
  guestId: string | null;
  trackId: string;
};

/** Gap used when appending, so there is always room to drag something between. */
const SORT_STEP = 1024;

export function appendSort(pending: PendingItem[]): number {
  if (!pending.length) return SORT_STEP;
  return Math.max(...pending.map((p) => p.sort)) + SORT_STEP;
}

/** Sort value that lands strictly between two neighbours. */
export function midpointSort(before: number | null, after: number | null): number {
  if (before == null && after == null) return SORT_STEP;
  if (before == null) return (after as number) - SORT_STEP / 2;
  if (after == null) return before + SORT_STEP;
  return (before + after) / 2;
}

/**
 * Where a guest add lands when the host has said requests come first.
 *
 * In front of the host's own list, behind the song on screen, and behind
 * guests who were already waiting - this is guests-before-the-host, not
 * last-in-first-out, and jumping in front of somebody who asked before you
 * would be a worse jukebox than the one we started with.
 */
export function guestsFirstSort(pending: PendingItem[]): number {
  const ordered = [...pending].sort((a, b) => a.sort - b.sort);
  if (!ordered.length) return SORT_STEP;

  // Index 0 is the song already on screen. Nothing goes in front of it.
  let end = 0;
  while (end + 1 < ordered.length && ordered[end + 1].guestId) end++;
  const nextOwn = end + 1 < ordered.length ? ordered[end + 1].sort : null;
  return midpointSort(ordered[end].sort, nextOwn);
}

// ── Host queue mirror ─────────────────────────────────────────────────────
// The room's queue is a mirror of what the host's own player is holding, not
// a second list beside it. The host pushes its whole ytQueue every few
// seconds and this works out the difference. Doing it as one pure function
// means the awkward part — telling a song the host deleted apart from a song
// a guest added a second ago — is testable and lives in one place.

export type HostQueueItem = {
  /** Position in the host's own player queue. */
  index: number;
  /** Null for anything not in the catalogue (a My Jukebox import, say). */
  trackId: string | null;
  videoId: string | null;
  /** The room row this is already mirrored to, once the server has made one. */
  itemId: string | null;
  /**
   * Who put it there, as the host is showing it. Carried only so the last
   * broadcast running order can keep the credit when the station goes quiet;
   * nothing in the reconcile reads it.
   */
  addedBy?: string | null;
};

export type MirrorRow = {
  id: string;
  trackId: string;
  status: string;
  sort: number;
  /** Epoch ms. */
  createdAt: number;
};

export type QueueStatus = "pending" | "playing" | "played";

export type MirrorPlan = {
  insert: { index: number; trackId: string; videoId: string | null; sort: number; status: QueueStatus }[];
  update: { id: string; sort: number; status: QueueStatus }[];
  /** Rows the host knew about and has since dropped from its own queue. */
  remove: string[];
  /** Rows the host has never seen: guest adds. It appends these and toasts them. */
  adopt: string[];
  /** Rows the host still lists that the room has removed. It drops these. */
  drop: string[];
};

export function statusForIndex(index: number, currentIndex: number): QueueStatus {
  if (currentIndex < 0) return "pending";
  if (index < currentIndex) return "played";
  if (index === currentIndex) return "playing";
  return "pending";
}

export function reconcileHostQueue(opts: {
  items: HostQueueItem[];
  /** Index of the song on screen, or -1 when nothing is playing. */
  currentIndex: number;
  /** Every pending/playing row in the room, plus any row the snapshot claims. */
  existing: MirrorRow[];
  /**
   * When the host last heard from the server, by the server's clock. A row
   * created after this is something the host cannot have known about, so it is
   * a guest add to adopt rather than a deletion to honour.
   */
  snapshotAtMs: number;
}): MirrorPlan {
  const byId = new Map(opts.existing.map((r) => [r.id, r]));
  const claimed = new Set<string>();
  const plan: MirrorPlan = { insert: [], update: [], remove: [], adopt: [], drop: [] };

  for (const item of opts.items) {
    const status = statusForIndex(item.index, opts.currentIndex);
    const sort = (item.index + 1) * SORT_STEP;
    const row = item.itemId ? byId.get(item.itemId) : undefined;

    if (row) {
      claimed.add(row.id);
      // The owner (or the guest who added it) took it out of the room while
      // the host still had it queued. The room wins; the host drops it.
      if (row.status === "removed") {
        plan.drop.push(row.id);
        continue;
      }
      // Only what actually moved. In the steady state a host pushing the same
      // queue every three seconds writes nothing at all; a track change writes
      // two rows.
      if (row.sort !== sort || row.status !== status) {
        plan.update.push({ id: row.id, sort, status });
      }
      continue;
    }

    // No row yet. Anything outside the catalogue simply is not mirrorable —
    // jukebox_queue.track_id is a real foreign key — so it stays a private
    // part of the host's queue and guests never see it.
    if (!item.trackId) continue;
    // Nor is a song the host played before the room ever heard of it. Writing
    // those in would invent a history the room did not have, which is exactly
    // what a host reloading its tab would produce.
    if (status === "played") continue;
    plan.insert.push({ index: item.index, trackId: item.trackId, videoId: item.videoId, sort, status });
  }

  for (const row of opts.existing) {
    if (claimed.has(row.id)) continue;
    if (row.status !== "pending" && row.status !== "playing") continue;
    if (row.createdAt > opts.snapshotAtMs) plan.adopt.push(row.id);
    else plan.remove.push(row.id);
  }

  return plan;
}

// ── The add rule ──────────────────────────────────────────────────────────

export type AddContext = {
  isLive: boolean;
  settings: JukeboxSettings;
  guestBanned: boolean;
  pending: PendingItem[];
  guestId: string | null;
  trackId: string;
  /** Owner adds bypass the guest rules; it is their jukebox. */
  isOwner: boolean;
};

export type AddDecision =
  | { ok: true; sort: number }
  | { ok: false; code: string; message: string };

export function decideAdd(ctx: AddContext): AddDecision {
  const { settings } = ctx;

  if (ctx.guestBanned) {
    return { ok: false, code: "banned", message: "You can no longer add songs to this jukebox." };
  }
  // Never, and it is not a setting. A song queued into a room nobody is
  // playing is a request nobody hears.
  if (!ctx.isOwner && !ctx.isLive) {
    return {
      ok: false,
      code: "offline",
      message: "This jukebox is not playing right now, so it is not taking requests.",
    };
  }
  if (ctx.pending.length >= MAX_PENDING_TOTAL) {
    return {
      ok: false,
      code: "queue_full",
      message: "The queue is full. Try again once a few songs have played.",
    };
  }
  // Explicit tracks are always allowed; this is a record collection.
  if (ctx.pending.some((p) => p.trackId === ctx.trackId)) {
    return { ok: false, code: "duplicate", message: "That song is already waiting in the queue." };
  }
  if (!ctx.isOwner && settings.maxPendingPerGuest > 0) {
    const mine = ctx.pending.filter((p) => p.guestId && p.guestId === ctx.guestId).length;
    if (mine >= settings.maxPendingPerGuest) {
      const n = settings.maxPendingPerGuest;
      return {
        ok: false,
        code: "cap",
        message: `You already have ${n} song${n === 1 ? "" : "s"} waiting. Remove one to add another.`,
      };
    }
  }

  // The host's own adds always go on the end; it is their list. A guest's
  // goes in front of it or behind it, which is the only question left.
  const sort =
    !ctx.isOwner && settings.guestsFirst
      ? guestsFirstSort(ctx.pending)
      : appendSort(ctx.pending);
  return { ok: true, sort };
}

/** A guest may pull back their own waiting song, and nothing else. */
export function canGuestRemove(
  item: { guestId: string | null; status: string },
  guestId: string,
): boolean {
  return item.status === "pending" && !!item.guestId && item.guestId === guestId;
}
