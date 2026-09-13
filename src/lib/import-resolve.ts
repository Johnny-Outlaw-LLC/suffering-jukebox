// Turning what somebody pasted into rows they can play.
//
// import-intake.ts decides what the input IS. This decides what we can do with
// it: which songs are already in the Jukebox (and which upload of each plays),
// what a pasted YouTube link is, and what a YouTube playlist holds. It never
// writes. YouTube searching for the songs we do not have stays in the browser,
// through /api/my-jukebox/search, because that endpoint already carries the
// sign-in requirement and the per-minute cap that protect the daily quota.

import {
  JUKEBOX_SCHEMA,
  fetchYouTubePlaylistInfo,
  fetchYouTubePlaylistItems,
  fetchYouTubeVideoInfo,
} from "@/lib/sj-admin-auth";
import type { ServiceClient } from "@/lib/jukebox-db";
import {
  artistMatches,
  emptyResolveIndex,
  normTitle,
  resolveCandidate,
  resolveCatalogIndex,
  resolvePrivateIndexFor,
  type CatalogTrack,
  type MatchResult,
  type ResolveIndex,
} from "@/lib/catalog-index";
import { songCandidates, songQuery, type IntakeSong } from "@/lib/import-intake";

export type ImportRow = {
  key: string;
  /** What the listener typed or pasted, for showing the row back to them. */
  line: string;
  artist: string | null;
  title: string;
  /** Words to search YouTube with while this row has nothing to play. */
  query: string | null;
  trackId: string | null;
  videoId: string | null;
  /** Raw YouTube title and channel, so the browser can read an artist off them. */
  ytTitle: string | null;
  ytChannel: string | null;
  thumbnail: string | null;
  durationMs: number | null;
  /** catalog = already a Jukebox song; youtube = playable but not imported yet. */
  source: "catalog" | "youtube" | "none";
  /** A catalogue match on a title alone, or a loose one. Worth a second look. */
  weak: boolean;
  note: string | null;
};

const thumb = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

async function indexesFor(sb: ServiceClient, email: string | null): Promise<ResolveIndex[]> {
  const [shared, mine] = await Promise.all([
    resolveCatalogIndex(sb),
    email ? resolvePrivateIndexFor(sb, email) : Promise.resolve(emptyResolveIndex()),
  ]);
  return [shared, mine];
}

function bestMatch(indexes: ResolveIndex[], song: IntakeSong): MatchResult | null {
  let best: MatchResult | null = null;
  for (const candidate of songCandidates(song)) {
    const match = resolveCandidate(indexes, candidate);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}

/**
 * The upload each track should play: the primary one if YouTube still plays it,
 * otherwise any version that does. A track with no playable version is left
 * out, so the row falls through to a YouTube search instead of a dead button.
 */
async function playableVideos(sb: ServiceClient, trackIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(trackIds));
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .select("track_id,video_id,is_primary,is_playable")
      .in("track_id", ids.slice(i, i + 150));
    if (error) throw error;
    const fallback = new Map<string, string>();
    for (const row of (data ?? []) as any[]) {
      if (row.is_playable === false) continue;
      if (row.is_primary) out.set(row.track_id, row.video_id);
      else if (!fallback.has(row.track_id)) fallback.set(row.track_id, row.video_id);
    }
    for (const [tid, vid] of fallback) if (!out.has(tid)) out.set(tid, vid);
  }
  return out;
}

type KnownTrack = { id: string; name: string; artist: string; durationMs: number | null };

/** Catalogue tracks already carrying these exact uploads. */
async function tracksForVideos(sb: ServiceClient, videoIds: string[]): Promise<Map<string, KnownTrack>> {
  const out = new Map<string, KnownTrack>();
  const ids = Array.from(new Set(videoIds));
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .select("video_id,tracks!inner(id,name,duration_ms,albums(artists(name)))")
      .in("video_id", ids.slice(i, i + 150));
    if (error) throw error;
    for (const row of (data ?? []) as any[]) {
      const t = row.tracks;
      if (!t?.id || out.has(row.video_id)) continue;
      out.set(row.video_id, {
        id: t.id,
        name: t.name || "",
        artist: t.albums?.artists?.name || "",
        durationMs: typeof t.duration_ms === "number" ? t.duration_ms : null,
      });
    }
  }
  return out;
}

async function videoInfo(videoIds: string[]) {
  const ids = Array.from(new Set(videoIds));
  const info: Awaited<ReturnType<typeof fetchYouTubeVideoInfo>> = {};
  for (let i = 0; i < ids.length; i += 50) Object.assign(info, await fetchYouTubeVideoInfo(ids.slice(i, i + 50)));
  return info;
}

function youtubeRow(key: string, line: string, videoId: string, info: any, known: KnownTrack | undefined): ImportRow {
  if (!info?.playable) {
    return {
      key, line, artist: null, title: info?.title || line, query: null, trackId: null, videoId: null,
      ytTitle: null, ytChannel: null, thumbnail: null, durationMs: null, source: "none", weak: false,
      note: info ? "YouTube will not let this video play here." : "That video could not be found.",
    };
  }
  if (known) {
    return {
      key, line, artist: known.artist || null, title: known.name, query: null, trackId: known.id, videoId,
      ytTitle: info.title ?? null, ytChannel: info.channelTitle ?? null,
      thumbnail: info.thumbnail || thumb(videoId), durationMs: known.durationMs ?? info.durationMs ?? null,
      source: "catalog", weak: false, note: null,
    };
  }
  return {
    key, line, artist: null, title: info.title || "Untitled video", query: null, trackId: null, videoId,
    ytTitle: info.title ?? null, ytChannel: info.channelTitle ?? null,
    thumbnail: info.thumbnail || thumb(videoId), durationMs: info.durationMs ?? null,
    source: "youtube", weak: false, note: null,
  };
}

/** A list of songs (typed, pasted or read off a picture) matched against the Jukebox. */
export async function resolveSongs(sb: ServiceClient, email: string | null, songs: IntakeSong[]): Promise<ImportRow[]> {
  const indexes = await indexesFor(sb, email);
  const matches = songs.map((song) => (song.videoId ? null : bestMatch(indexes, song)));
  const linkIds = songs.map((s) => s.videoId).filter((v): v is string => !!v);

  const [videos, info, known] = await Promise.all([
    playableVideos(sb, matches.filter((m): m is MatchResult => !!m).map((m) => m.trackId)),
    linkIds.length ? videoInfo(linkIds) : Promise.resolve({} as Record<string, any>),
    linkIds.length ? tracksForVideos(sb, linkIds) : Promise.resolve(new Map<string, KnownTrack>()),
  ]);

  return songs.map((song, i) => {
    const key = `r${i}`;
    if (song.videoId) return youtubeRow(key, song.line, song.videoId, info[song.videoId], known.get(song.videoId));
    const match = matches[i];
    const videoId = match ? videos.get(match.trackId) : undefined;
    if (match && videoId) {
      return {
        key, line: song.line, artist: match.artist || song.artist, title: match.name, query: null,
        trackId: match.trackId, videoId, ytTitle: null, ytChannel: null, thumbnail: thumb(videoId),
        durationMs: match.durationMs, source: "catalog", weak: match.weak, note: null,
      };
    }
    return {
      key, line: song.line, artist: song.artist, title: song.title, query: songQuery(song),
      trackId: null, videoId: null, ytTitle: null, ytChannel: null, thumbnail: null, durationMs: null,
      source: "none", weak: false, note: null,
    };
  });
}

/** Every playable song on a public or unlisted YouTube playlist. */
export async function resolvePlaylist(sb: ServiceClient, playlistId: string) {
  const [playlist, listing] = await Promise.all([
    fetchYouTubePlaylistInfo(playlistId),
    fetchYouTubePlaylistItems(playlistId),
  ]);
  if (!playlist) return null;
  const seen = new Set<string>();
  const items = listing.items.filter((it) => (seen.has(it.videoId) ? false : (seen.add(it.videoId), true)));
  const ids = items.map((it) => it.videoId);
  const [info, known] = await Promise.all([videoInfo(ids), tracksForVideos(sb, ids)]);
  const rows = items
    .map((it, i) => youtubeRow(`r${i}`, it.title || "", it.videoId, info[it.videoId], known.get(it.videoId)))
    // A deleted or private entry in somebody's playlist is not worth a row.
    .filter((row) => row.source !== "none");
  return { title: (playlist as any).title || "YouTube playlist", rows, truncated: listing.truncated };
}

const ARTIST_LIMIT = 4;
const ARTIST_SONGS = 60;
const SONG_LIMIT = 25;

/**
 * A search typed into the box: artists we hold whose name matches, and songs
 * whose title does. Catalogue only - a YouTube search is 100 units of a 10,000
 * unit day, so the browser asks for one when this comes back thin, not before.
 */
export async function searchCatalog(sb: ServiceClient, email: string | null, query: string) {
  const q = normTitle(query);
  if (!q) return { artists: [], rows: [] as ImportRow[] };
  const indexes = await indexesFor(sb, email);

  const artistHits: { name: string; tracks: CatalogTrack[] }[] = [];
  const songHits: CatalogTrack[] = [];
  const seenTrack = new Set<string>();
  for (const index of indexes) {
    for (const [artistKey, tracks] of index.byArtist) {
      if (artistHits.length < ARTIST_LIMIT && (artistKey === q || artistMatches(artistKey, q))) {
        artistHits.push({ name: tracks[0]?.artist || query, tracks: tracks.slice(0, ARTIST_SONGS) });
      }
    }
    for (const [titleKey, tracks] of index.byTitle) {
      if (songHits.length >= SONG_LIMIT) break;
      // A song hit is a title that contains what was typed. The other way round
      // ("silver" inside "silver jews") turns every artist search into noise.
      if (titleKey !== q && !(q.length >= 3 && titleKey.includes(q))) continue;
      for (const t of tracks) {
        if (seenTrack.has(t.id) || songHits.length >= SONG_LIMIT) continue;
        seenTrack.add(t.id);
        songHits.push(t);
      }
    }
  }
  // Exact titles first, then whatever merely contains the words.
  songHits.sort((a, b) => Number(b.nt === q) - Number(a.nt === q));

  const all = [...artistHits.flatMap((a) => a.tracks), ...songHits];
  const videos = await playableVideos(sb, all.map((t) => t.id));
  const toRow = (t: CatalogTrack, i: number, prefix: string): ImportRow | null => {
    const videoId = videos.get(t.id);
    if (!videoId) return null;
    return {
      key: `${prefix}${i}`, line: `${t.artist} - ${t.name}`, artist: t.artist || null, title: t.name, query: null,
      trackId: t.id, videoId, ytTitle: null, ytChannel: null, thumbnail: thumb(videoId), durationMs: t.durationMs,
      source: "catalog", weak: false, note: null,
    };
  };
  return {
    artists: artistHits.map((a, ai) => ({
      name: a.name,
      rows: a.tracks.map((t, i) => toRow(t, i, `a${ai}-`)).filter((r): r is ImportRow => !!r),
    })).filter((a) => a.rows.length),
    rows: songHits.map((t, i) => toRow(t, i, "s")).filter((r): r is ImportRow => !!r),
  };
}
