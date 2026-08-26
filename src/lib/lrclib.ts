// Johnny Outlaw, LLC — Suffering Jukebox — LRCLIB lyric lookup.
//
// The same source and the same two-pass shape the community-import edge
// function uses for an artist import, so a song that arrives one at a time
// through the Spotify wizard gets its words the same way an album track does.
// There is no scraper here and never should be: LRCLIB or nothing.

const UA = "SufferingJukebox/1.0 (+https://sufferingjukebox.stream)";
const TIMEOUT_MS = 8000;

async function tfetch(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

function fold(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function similar(a: string, b: string) {
  const x = fold(a), y = fold(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export type LyricHit = { plain: string | null; synced: string | null };

/** Turns a timed .lrc into flat text, so a song always has something to show. */
export function plainFrom(hit: LyricHit) {
  if (hit.plain) return hit.plain;
  if (!hit.synced) return null;
  const lines = hit.synced.replace(/\[[^\]]*\]/g, "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

/**
 * Spotify and YouTube titles often carry a remaster year or a featuring credit
 * that LRCLIB does not. Strip those for the query; keep the stored name alone.
 */
export function lyricQueryName(track: string): string {
  const cleaned = (track || "")
    .replace(/\s*[-–—]\s*\d{2,4}\s*remaster(ed)?\b.*$/i, "")
    .replace(/\s*\(\s*\d{2,4}\s*remaster(ed)?\s*\)/gi, "")
    .replace(/\s*\[?\s*remaster(ed)?\s*\]?/gi, " ")
    .replace(/\s*[\(\[]\s*(feat\.?|ft\.?|with)\s+[^\)\]]+[\)\]]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || track;
}

/** First credited name when Spotify joins artists with a comma. */
export function lyricQueryArtist(artist: string): string {
  const primary = (artist || "").split(/\s*,\s*/)[0]?.trim() || "";
  return primary || artist;
}

async function lookupOnce(artist: string, track: string, durationSec: number | null): Promise<LyricHit | null> {
  if (!artist?.trim() || !track?.trim()) return null;
  if (durationSec) {
    try {
      const res = await tfetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}&duration=${Math.round(durationSec)}`);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && (data.plainLyrics || data.syncedLyrics)) return { plain: data.plainLyrics || null, synced: data.syncedLyrics || null };
      }
    } catch { /* timed out - fall through to the search */ }
  }
  try {
    const res = await tfetch(`https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}`);
    if (!res.ok) return null;
    const list = await res.json().catch(() => []);
    if (!Array.isArray(list)) return null;
    const candidates = list.filter((d: any) =>
      similar(d.artistName || "", artist) && similar(d.trackName || "", track) &&
      (!durationSec || !d.duration || Math.abs(d.duration - durationSec) <= 10));
    const best = candidates.find((d: any) => d.syncedLyrics) || candidates.find((d: any) => d.plainLyrics);
    if (!best) return null;
    return { plain: best.plainLyrics || null, synced: best.syncedLyrics || null };
  } catch { return null; }
}

// Exact-duration lookup first because it is the one that cannot be wrong, then
// a name search filtered back down by artist, title and a ten second duration
// window. Tries a cleaned title and the primary artist when the raw Spotify
// credit misses. A synced result beats a plain one.
export async function lrclibLookup(artist: string, track: string, durationSec: number | null): Promise<LyricHit | null> {
  const artists = [...new Set([artist, lyricQueryArtist(artist)].filter(Boolean))];
  const titles = [...new Set([lyricQueryName(track), track].filter(Boolean))];
  for (const a of artists) {
    for (const t of titles) {
      const hit = await lookupOnce(a, t, durationSec);
      if (hit) return hit;
    }
  }
  return null;
}
