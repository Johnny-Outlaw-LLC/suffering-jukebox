// Spotify Extended Streaming History — parse, aggregate, and shape for import.
// The GDPR export carries IP addresses; those are stripped here and must never
// be posted to the server.

export type SpotifyHistoryPlay = {
  ts: string;
  msPlayed: number;
  title: string;
  artist: string;
  album: string;
  uri: string;
  skipped: boolean;
};

export type SpotifyHistoryTrack = {
  uri: string;
  title: string;
  artist: string;
  album: string;
  plays: number;
  msPlayed: number;
  lastPlayed: string;
  skippedPlays: number;
};

const MIN_MS = 30_000;

/** One GDPR Streaming_History_Audio_*.json row → cleaned play, or null. */
export function normalizeHistoryRow(row: Record<string, unknown> | null | undefined): SpotifyHistoryPlay | null {
  if (!row || typeof row !== "object") return null;
  if (row.episode_name || row.spotify_episode_uri || row.audiobook_uri) return null;
  const title = String(row.master_metadata_track_name || "").trim();
  const artist = String(row.master_metadata_album_artist_name || "").trim();
  const album = String(row.master_metadata_album_album_name || "").trim();
  const uri = String(row.spotify_track_uri || "").trim();
  const ts = String(row.ts || "").trim();
  const msPlayed = Number(row.ms_played) || 0;
  if (!title || !artist || !uri || !ts) return null;
  if (!uri.startsWith("spotify:track:")) return null;
  return {
    ts,
    msPlayed,
    title,
    artist,
    album,
    uri,
    skipped: !!row.skipped,
  };
}

export function parseHistoryJson(text: string): SpotifyHistoryPlay[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!Array.isArray(data)) throw new Error("Spotify history files are a JSON array of plays.");
  const out: SpotifyHistoryPlay[] = [];
  for (const row of data) {
    const play = normalizeHistoryRow(row as Record<string, unknown>);
    if (play) out.push(play);
  }
  return out;
}

/** Unique tracks ranked by play count, dropping short skips by default. */
export function aggregateTracks(
  plays: SpotifyHistoryPlay[],
  opts: { minMs?: number } = {},
): SpotifyHistoryTrack[] {
  const minMs = opts.minMs ?? MIN_MS;
  const map = new Map<string, SpotifyHistoryTrack>();
  for (const play of plays) {
    if (play.msPlayed < minMs && !play.skipped) {
      // Still count short listens that were not marked skipped — many real
      // listens end under 30s on shuffle. Only drop when Spotify says skipped
      // and the listen was short.
    }
    if (play.skipped && play.msPlayed < minMs) continue;
    const cur = map.get(play.uri);
    if (!cur) {
      map.set(play.uri, {
        uri: play.uri,
        title: play.title,
        artist: play.artist,
        album: play.album,
        plays: 1,
        msPlayed: play.msPlayed,
        lastPlayed: play.ts,
        skippedPlays: play.skipped ? 1 : 0,
      });
      continue;
    }
    cur.plays += 1;
    cur.msPlayed += play.msPlayed;
    if (play.skipped) cur.skippedPlays += 1;
    if (play.ts > cur.lastPlayed) {
      cur.lastPlayed = play.ts;
      cur.title = play.title;
      cur.artist = play.artist;
      cur.album = play.album;
    }
  }
  return [...map.values()].sort((a, b) => b.plays - a.plays || b.msPlayed - a.msPlayed);
}

export function groupByArtist(tracks: SpotifyHistoryTrack[]) {
  const map = new Map<string, { artist: string; plays: number; tracks: SpotifyHistoryTrack[] }>();
  for (const t of tracks) {
    const cur = map.get(t.artist) || { artist: t.artist, plays: 0, tracks: [] };
    cur.plays += t.plays;
    cur.tracks.push(t);
    map.set(t.artist, cur);
  }
  return [...map.values()].sort((a, b) => b.plays - a.plays);
}

export function groupByAlbum(tracks: SpotifyHistoryTrack[]) {
  const map = new Map<string, { artist: string; album: string; plays: number; tracks: SpotifyHistoryTrack[] }>();
  for (const t of tracks) {
    const key = t.artist + "\0" + t.album;
    const cur = map.get(key) || { artist: t.artist, album: t.album || "Unknown album", plays: 0, tracks: [] };
    cur.plays += t.plays;
    cur.tracks.push(t);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.plays - a.plays);
}

/** Reject payloads that still carry GDPR IP fields. */
export function assertNoIpLeak(body: unknown): void {
  const raw = JSON.stringify(body ?? {});
  if (/"ip_addr"\s*:/i.test(raw) || /"ip_address"\s*:/i.test(raw)) {
    throw new Error("History uploads must not include IP addresses.");
  }
}
