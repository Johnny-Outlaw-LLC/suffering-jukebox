// Johnny Outlaw, LLC — Suffering Jukebox — Interactive Jukebox domain layer.
//
// Pure rules, no I/O. Everything that decides whether an action is allowed
// lives here so the guest app, the host console and the API routes cannot
// disagree with each other. If you are about to write `if (settings.` in a
// route handler, write it in this file instead.

export type FairnessMode = "fifo" | "round_robin";

export type JukeboxSettings = {
  /** Songs a single guest may have waiting at once. 0 = unlimited. */
  maxPendingPerGuest: number;
  /** Allow a song already waiting in the queue to be added again. */
  allowDuplicates: boolean;
  /**
   * Let guests queue songs while the host is not playing. This is the "add
   * from bed, hear it in the bar tomorrow" setting.
   */
  allowOfflineAdds: boolean;
  /** FIFO appends. Round robin interleaves so one guest cannot stack the queue. */
  fairness: FairnessMode;
  /** Guests must enter a name rather than accepting the generated one. */
  requireName: boolean;
  /** Allow tracks flagged explicit. */
  allowExplicit: boolean;
};

export const DEFAULT_SETTINGS: JukeboxSettings = {
  maxPendingPerGuest: 3,
  allowDuplicates: false,
  allowOfflineAdds: false,
  fairness: "fifo",
  requireName: false,
  allowExplicit: true,
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
  return {
    maxPendingPerGuest: int(s.maxPendingPerGuest, DEFAULT_SETTINGS.maxPendingPerGuest, 0, 50),
    allowDuplicates: bool(s.allowDuplicates, DEFAULT_SETTINGS.allowDuplicates),
    allowOfflineAdds: bool(s.allowOfflineAdds, DEFAULT_SETTINGS.allowOfflineAdds),
    fairness: s.fairness === "round_robin" ? "round_robin" : "fifo",
    requireName: bool(s.requireName, DEFAULT_SETTINGS.requireName),
    allowExplicit: bool(s.allowExplicit, DEFAULT_SETTINGS.allowExplicit),
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

export function normalizeCode(input: string): string | null {
  const c = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === CODE_LENGTH ? c : null;
}

// ── Guest nicknames ───────────────────────────────────────────────────────
// Same trick the Save Playlist modal uses: lift a fragment out of a lyric so
// the name on the TV sounds like it belongs to the record collection.

const NICKNAME_FALLBACKS = [
  "Velvet Water", "Blue Arrangements", "Trains Across", "Slow Century",
  "Punks Beerlight", "Honk Party", "Silver Pageant", "Night Society",
  "Tennessee Room", "Cassette Weather", "Neon Dial", "Paper Hotel",
];

export function nicknameFromLyric(
  lyric: string | null | undefined,
  random: () => number = Math.random,
): string {
  const words = (lyric ?? "")
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[^A-Za-z']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3 && w.length <= 10);

  // Two consecutive words read like a name; one reads like a typo.
  if (words.length >= 2) {
    const start = Math.floor(random() * (words.length - 1));
    const name = [words[start], words[start + 1]].map(titleCase).join(" ");
    if (name.length >= 6 && name.length <= 24) return name;
  }
  if (words.length === 1 && words[0].length >= 4) return titleCase(words[0]);
  return NICKNAME_FALLBACKS[Math.floor(random() * NICKNAME_FALLBACKS.length)];
}

function titleCase(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

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
 * Where a new add lands under round robin. Each guest's Nth waiting song sits
 * in round N, and rounds play in order, so a guest who queues five songs gets
 * one slot per lap instead of five in a row.
 */
export function roundRobinSort(pending: PendingItem[], guestId: string | null): number {
  const ordered = [...pending].sort((a, b) => a.sort - b.sort);
  const seen = new Map<string, number>();
  const rounds: number[] = [];
  for (const item of ordered) {
    const key = item.guestId ?? "__owner__";
    const n = seen.get(key) ?? 0;
    rounds.push(n);
    seen.set(key, n + 1);
  }
  const newRound = seen.get(guestId ?? "__owner__") ?? 0;

  // Insert after the last item in a round at or before ours.
  let insertAfter = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (rounds[i] <= newRound) insertAfter = i;
  }
  if (insertAfter === ordered.length - 1) return appendSort(pending);
  const before = insertAfter >= 0 ? ordered[insertAfter].sort : null;
  const after = ordered[insertAfter + 1].sort;
  return midpointSort(before, after);
}

// ── The add rule ──────────────────────────────────────────────────────────

export type AddContext = {
  isLive: boolean;
  settings: JukeboxSettings;
  guestBanned: boolean;
  pending: PendingItem[];
  guestId: string | null;
  trackId: string;
  trackIsExplicit: boolean;
  /** Owner adds bypass the guest fairness rules; it is their jukebox. */
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
  if (!ctx.isOwner && !ctx.isLive && !settings.allowOfflineAdds) {
    return {
      ok: false,
      code: "offline",
      message:
        "This jukebox is not playing right now, and the owner has turned off adding while it is offline.",
    };
  }
  if (ctx.pending.length >= MAX_PENDING_TOTAL) {
    return {
      ok: false,
      code: "queue_full",
      message: "The queue is full. Try again once a few songs have played.",
    };
  }
  if (!ctx.isOwner && !settings.allowExplicit && ctx.trackIsExplicit) {
    return {
      ok: false,
      code: "explicit",
      message: "The owner has turned off explicit tracks on this jukebox.",
    };
  }
  if (!settings.allowDuplicates && ctx.pending.some((p) => p.trackId === ctx.trackId)) {
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

  const sort =
    !ctx.isOwner && settings.fairness === "round_robin"
      ? roundRobinSort(ctx.pending, ctx.guestId)
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
