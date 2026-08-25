// Johnny Outlaw, LLC — Suffering Jukebox — "do we already have this song?"
//
// The Spotify picker hides songs the Jukebox already holds. "Already holds"
// means the whole catalogue - every artist anybody has imported - not just the
// handful of singles the listener added to their own library. Somebody with
// 700 Liked Songs mostly wants to see the ones we are missing, and Purple
// Mountains being in the catalogue is exactly as good a reason to hide a song
// as their own library row is.
//
// Matching happens here rather than in the browser because the catalogue is
// 4,000+ tracks: shipping it to a phone to answer a yes/no question about 200
// songs would cost more than the answer is worth.

import { JUKEBOX_SCHEMA, type createSjServiceClient } from "@/lib/sj-admin-auth";

type Sb = ReturnType<typeof createSjServiceClient>;
const T = (sb: Sb, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

/** Letters and digits only, so "I Melt with You (Remastered 2006)" folds down. */
export function fold(value: string | null | undefined) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Brackets and a trailing "feat. …" come off: those are the parts that differ
// between the same song on Spotify and on YouTube. Deliberately not folded at
// the word "with" - "Dancing With Myself" is not a featuring credit.
export function normTitle(value: string | null | undefined) {
  return fold(
    (value || "")
      .toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(/\b(feat|ft|featuring)\b.*$/, " "),
  );
}

// The same band arrives as "Purple Mountains" from Spotify and "Purple
// Mountains - Topic" from a YouTube upload, so the artist only has to be
// compatible, never identical. Containment needs a few characters behind it,
// or "War" would answer for Warpaint.
export function artistMatches(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

// A catalogue track's name is frequently the raw YouTube upload title -
// "Daniel Johnston - Walking The Cow  HQ" - because that is what the importer
// was given. The clean Spotify title sits inside it, so exact equality is not
// enough and containment is the rule. The 40% floor is what stops "True Love"
// answering for "True Love Will Find You In The End" inside one artist's own
// catalogue, which is the only place this ever gets asked.
export function titleMatches(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 6 || !long.includes(short)) return false;
  return short.length / long.length >= 0.4;
}

/** normalised artist -> the normalised titles we hold for them. */
export type CatalogIndex = Map<string, Set<string>>;

export function emptyIndex(): CatalogIndex { return new Map(); }

export function addToIndex(index: CatalogIndex, title: string | null | undefined, artist: string | null | undefined) {
  const t = normTitle(title);
  const a = normTitle(artist);
  if (!t || !a) return;
  const titles = index.get(a);
  if (titles) titles.add(t);
  else index.set(a, new Set([t]));
}

// Keyed by artist rather than by title because that is the cheap way to keep
// the loose title rule honest: containment is only ever tested against the
// songs of an artist we already agreed is the same artist.
export function indexHas(indexes: CatalogIndex[], title: string, artist: string) {
  const t = normTitle(title);
  const a = normTitle(artist);
  if (!t || !a) return false;
  for (const index of indexes) {
    for (const [knownArtist, titles] of index) {
      if (!artistMatches(knownArtist, a)) continue;
      if (titles.has(t)) return true;
      for (const known of titles) if (titleMatches(t, known)) return true;
    }
  }
  return false;
}

// Five minutes. An import that lands mid-session shows up on the next source
// load rather than the current one, which nobody will ever notice, and the
// alternative is paging 4,000 rows every time somebody opens the picker.
const TTL_MS = 5 * 60 * 1000;
const PAGE = 1000;

let cached: { at: number; index: CatalogIndex } | null = null;

export function invalidateCatalogIndex() { cached = null; }

type TrackRow = { name?: string; albums?: { visibility?: string | null; artists?: { name?: string; visibility?: string | null } } };

function buildFrom(rows: TrackRow[], index: CatalogIndex, allow?: (row: TrackRow) => boolean) {
  rows.forEach((row) => {
    if (allow && !allow(row)) return;
    addToIndex(index, row.name, row.albums?.artists?.name);
  });
}

/** The public catalogue: what everybody can already play. Cached across users. */
export async function catalogIndex(sb: Sb): Promise<CatalogIndex> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.index;
  const index = emptyIndex();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await T(sb, "tracks")
      .select("name,albums!inner(artists!inner(name,visibility))")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as TrackRow[];
    buildFrom(rows, index, (row) => (row.albums?.artists?.visibility ?? "public") === "public");
    if (rows.length < PAGE) break;
  }
  cached = { at: Date.now(), index };
  return index;
}

/**
 * The private artists this listener imported. Their songs are in their jukebox
 * as surely as a public artist's are, but nobody else's picker should hide
 * music they cannot see, so this is looked up per person and never cached.
 */
export async function privateIndexFor(sb: Sb, userEmail: string): Promise<CatalogIndex> {
  const index = emptyIndex();
  if (!userEmail) return index;
  const { data: access, error } = await T(sb, "content_access").select("artist_id").eq("user_email", userEmail);
  if (error) throw error;
  const artistIds = (access ?? []).map((row: any) => row.artist_id as string).filter(Boolean);
  if (!artistIds.length) return index;
  const { data, error: trackError } = await T(sb, "tracks")
    .select("name,albums!inner(artist_id,artists!inner(name))")
    .in("albums.artist_id", artistIds)
    .limit(5000);
  if (trackError) throw trackError;
  buildFrom((data ?? []) as TrackRow[], index);
  return index;
}
