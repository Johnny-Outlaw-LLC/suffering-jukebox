// Johnny Outlaw, LLC — Suffering Jukebox — smart album matching.
//
// A song added from YouTube used to always land in a catch-all "Singles"
// album for its artist, even when it was plainly track 4 of a real record.
// This asks iTunes (free, keyless) what album a song actually belongs to, so
// "Ain't No Sunshine" lands under Just As I Am with its real cover instead of
// a grey square. It only falls back to Singles when nothing confident comes
// back — a cover version, a live recording, a wedding-playlist mashup.

import { artistMatches, normTitle, titleMatches } from "@/lib/catalog-index";

export type AlbumMatch = {
  albumName: string;
  artworkUrl: string | null;
  trackNumber: number | null;
  discNumber: number | null;
};

// iTunes' artwork URLs end in a fixed thumbnail size; every size up to 600 is
// the same asset at a different path segment.
function upsizeArtwork(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/600x600bb.$1");
}

// iTunes rate-limits to roughly 20 requests/minute per IP. A playlist import
// walks dozens of tracks in one loop, so every lookup pays this small tax
// rather than tripping a 403 partway through.
const THROTTLE_MS = 350;
let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = lastCall + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

/**
 * Best-effort. A network hiccup or an unconfident result both just mean
 * "fall back to Singles" — this never throws.
 */
export async function lookupAlbumForTrack(
  artistName: string,
  trackName: string,
  durationMs?: number | null,
): Promise<AlbumMatch | null> {
  try {
    await throttle();
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", `${artistName} ${trackName}`.trim());
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "5");
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: any[] };
    const nArtist = normTitle(artistName);
    const nTrack = normTitle(trackName);
    let best: any = null;
    for (const c of json.results ?? []) {
      if (!c.collectionName || !c.artistName || !c.trackName) continue;
      if (!artistMatches(normTitle(c.artistName), nArtist)) continue;
      if (!titleMatches(normTitle(c.trackName), nTrack)) continue;
      if (durationMs && c.trackTimeMillis) {
        // A duration within 15s is the tie-breaker once more than one
        // candidate passes the name check (compilations, re-releases).
        const diff = Math.abs(c.trackTimeMillis - durationMs);
        if (diff > 15000) continue;
        if (!best || diff < Math.abs(best.trackTimeMillis - durationMs)) best = c;
      } else if (!best) {
        best = c;
      }
    }
    if (!best) return null;
    return {
      albumName: best.collectionName,
      artworkUrl: upsizeArtwork(best.artworkUrl100),
      trackNumber: typeof best.trackNumber === "number" ? best.trackNumber : null,
      discNumber: typeof best.discNumber === "number" ? best.discNumber : null,
    };
  } catch {
    return null;
  }
}
