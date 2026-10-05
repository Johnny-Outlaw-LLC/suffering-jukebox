import type { SupabaseClient } from "@supabase/supabase-js";
import { JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

/// Is every song an artist uploaded actually playable by the public?
///
/// Artist uploads (Nouns Group) broke over and over, each time for a different
/// reason: a signed link that expired in an open tab, Listening Party missing
/// its B2 keys, a cross-site redirect the browser refused. In every case the
/// database looked fine. So this does not trust the database: it lists what
/// the public catalogue SHOWS as an artist upload, then asks each site for the
/// first bytes of each song, exactly as a listener's <audio> element would.
///
/// The list deliberately comes from the catalogue flags, not from the signer's
/// eligibility rule (onDemandArtistAudioTracks). A song the page offers but the
/// signer refuses - a bumped agreement version, a withdrawn approval nobody
/// meant - is precisely the failure this exists to catch.

export type ArtistAudioSong = { trackId: string; track: string; artist: string };
export type ArtistAudioFailure = ArtistAudioSong & { host: string; status: number | null; reason: string };
export type ArtistAudioReport = {
  checkedAt: string;
  songs: number;
  hosts: string[];
  checks: number;
  failures: ArtistAudioFailure[];
};

export async function publicArtistAudioSongs(sb: SupabaseClient): Promise<ArtistAudioSong[]> {
  const db = sb.schema(JUKEBOX_SCHEMA);
  const { data: tracks, error } = await db.from("tracks")
    .select("id,name,album_id,visibility,artist_audio_visible")
    .eq("artist_audio_only", true);
  if (error) throw error;
  const live = (tracks ?? []).filter((t) => t.artist_audio_visible && (t.visibility ?? "public") === "public");
  const albumIds = [...new Set(live.map((t) => t.album_id).filter(Boolean))] as string[];
  if (!albumIds.length) return [];
  const { data: albums, error: albumError } = await db.from("albums")
    .select("id,artist_id,visibility,artist_audio_visible").in("id", albumIds);
  if (albumError) throw albumError;
  const albumMap = new Map((albums ?? [])
    .filter((a) => a.artist_audio_visible && (a.visibility ?? "public") === "public")
    .map((a) => [a.id, a]));
  const artistIds = [...new Set([...albumMap.values()].map((a) => a.artist_id))];
  if (!artistIds.length) return [];
  const { data: artists, error: artistError } = await db.from("artists")
    .select("id,name,visibility,artist_audio_visible").in("id", artistIds);
  if (artistError) throw artistError;
  const artistMap = new Map((artists ?? [])
    .filter((a) => a.artist_audio_visible !== false && (a.visibility ?? "public") === "public")
    .map((a) => [a.id, a]));
  const songs: ArtistAudioSong[] = [];
  for (const t of live) {
    const album = albumMap.get(t.album_id);
    const artist = album && artistMap.get(album.artist_id);
    if (artist) songs.push({ trackId: t.id, track: t.name, artist: artist.name });
  }
  return songs;
}

export function artistStreamUrl(host: string, trackId: string): string {
  return `${host.replace(/\/+$/, "")}/api/sj-artist-audio?purpose=normal-playback&format=stream&track_ids=${encodeURIComponent(trackId)}`;
}

/// Fetch two bytes of one song from one site, following the redirect to B2.
export async function probeArtistStream(
  host: string,
  song: ArtistAudioSong,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20000,
): Promise<ArtistAudioFailure | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(artistStreamUrl(host, song.trackId), {
      headers: { Range: "bytes=0-1" }, redirect: "follow", cache: "no-store", signal: ctrl.signal,
    });
    const type = r.headers.get("content-type") || "";
    if (r.status !== 206 && r.status !== 200) {
      return { ...song, host, status: r.status, reason: `answered ${r.status}` };
    }
    if (!/audio|octet-stream|mp4/i.test(type)) {
      return { ...song, host, status: r.status, reason: `not audio (${type || "no content type"})` };
    }
    const bytes = (await r.arrayBuffer()).byteLength;
    if (!bytes) return { ...song, host, status: r.status, reason: "no audio bytes" };
    return null;
  } catch (e) {
    const reason = (e as Error)?.name === "AbortError" ? `no answer in ${timeoutMs / 1000}s` : String((e as Error)?.message || e);
    return { ...song, host, status: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkArtistAudio(
  songs: ArtistAudioSong[],
  hosts: string[],
  fetchImpl: typeof fetch = fetch,
  concurrency = 6,
): Promise<ArtistAudioReport> {
  const jobs = hosts.flatMap((host) => songs.map((song) => () => probeArtistStream(host, song, fetchImpl)));
  const failures: ArtistAudioFailure[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const failure = await job();
      if (failure) failures.push(failure);
    }
  }));
  return { checkedAt: new Date().toISOString(), songs: songs.length, hosts, checks: jobs.length, failures };
}

export function artistAudioAlertHtml(report: ArtistAudioReport): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  const rows = report.failures.map((f) =>
    `<tr><td style="padding:4px 10px 4px 0">${esc(f.artist)}</td><td style="padding:4px 10px 4px 0">${esc(f.track)}</td><td style="padding:4px 10px 4px 0">${esc(f.host.replace(/^https?:\/\//, ""))}</td><td style="padding:4px 0">${esc(f.reason)}</td></tr>`).join("");
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222"><h2 style="margin:0 0 8px">Artist uploads are not playing</h2>`
    + `<p>${report.failures.length} of ${report.checks} checks failed (${report.songs} songs on ${report.hosts.length} sites) at ${esc(report.checkedAt)}.</p>`
    + `<table style="border-collapse:collapse;font-size:14px"><tr><th align="left">Artist</th><th align="left">Song</th><th align="left">Site</th><th align="left">Problem</th></tr>${rows}</table>`
    + `<p style="color:#666;font-size:13px">Sent by /api/sj-artist-audio-health. It runs every night and re-checks on demand.</p></body></html>`;
}
