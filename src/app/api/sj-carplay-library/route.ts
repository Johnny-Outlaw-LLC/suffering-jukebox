import { NextRequest, NextResponse } from "next/server";
import { ARTIST_AGREEMENT_VERSION } from "@/lib/artist-rights";
import { onDemandArtistAudioTracks } from "@/lib/bg-audio-eligibility";
import { createB2DownloadUrl, isOwnedAudioKey, sisterB2RedirectUrl } from "@/lib/b2-audio";
import { getAuthUser, createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { SURFACES } from "@/lib/surface";

/**
 * Everything CarPlay may stream: approved artist uploads (anyone), plus the
 * caller's own uploads when signed in.
 *
 * CarPlay used to offer only files already downloaded to the phone, so a car
 * with signal still showed "Nothing downloaded yet". The phone pushes this
 * list to the native side whenever the app is open, and the car streams from
 * it - a downloaded copy still wins, so offline driving is unchanged.
 *
 * URLs are signed for B2's seven-day maximum, not the site's usual six hours:
 * the car cannot ask for a fresh one (the web view that holds the session is
 * asleep), so the list has to outlast a week of drives between app opens. The
 * artist half needs no session, so native can refresh that part on its own.
 */

export const dynamic = "force-dynamic";

const SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
const MAX_PERSONAL = 5_000;
const B2_CONCURRENCY = 16;

type ServiceClient = ReturnType<typeof createSjServiceClient>;

type LibraryTrack = {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  durationSeconds: number;
  url: string;
  source: "artist" | "personal";
};

type Source = { trackId: string; storagePath: string; duration: number | null; source: LibraryTrack["source"] };

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Covers are stored as site-relative paths (/album-art/..., /artist-release-art/...)
// as often as full URLs, and the native side has no origin to resolve them against.
function absoluteArt(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return SURFACES.sj.url + url;
  return null;
}

async function artistSources(sb: ServiceClient): Promise<Source[]> {
  const eligible = await onDemandArtistAudioTracks(sb, ARTIST_AGREEMENT_VERSION);
  const out: Source[] = [];
  for (const part of chunk(eligible, 100)) {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA)
      .from("track_audio").select("id,storage_path,duration_seconds")
      .in("id", part.map((row) => row.track_audio_id));
    if (error) throw error;
    const byId = new Map((data ?? []).map((row) => [row.id, row]));
    part.forEach((row) => {
      const audio = byId.get(row.track_audio_id);
      if (!audio?.storage_path) return;
      out.push({ trackId: row.track_id, storagePath: audio.storage_path,
        duration: Number(audio.duration_seconds) || null, source: "artist" });
    });
  }
  return out;
}

async function personalSources(sb: ServiceClient, userId: string): Promise<Source[]> {
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA)
    .from("track_audio").select("track_id,storage_path,duration_seconds")
    .eq("uploaded_by", userId)
    .not("storage_path", "is", null)
    .limit(MAX_PERSONAL);
  if (error) throw error;
  return (data ?? [])
    .filter((row) => row.storage_path && isOwnedAudioKey(row.storage_path, userId, row.track_id))
    .map((row) => ({ trackId: row.track_id, storagePath: row.storage_path!,
      duration: Number(row.duration_seconds) || null, source: "personal" as const }));
}

/** Title, artist, album and cover for each track, in three batched lookups. */
async function describe(sb: ServiceClient, ids: string[]) {
  const tracks = new Map<string, { name: string; albumId: string | null; durationMs: number | null }>();
  const albums = new Map<string, { name: string; artistId: string | null; artUrl: string | null }>();
  const artists = new Map<string, string>();

  for (const part of chunk(ids, 100)) {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA)
      .from("tracks").select("id,name,album_id,duration_ms").in("id", part);
    if (error) throw error;
    (data ?? []).forEach((row) =>
      tracks.set(row.id, { name: row.name, albumId: row.album_id, durationMs: row.duration_ms }));
  }
  const albumIds = [...new Set([...tracks.values()].map((t) => t.albumId).filter(Boolean))] as string[];
  for (const part of chunk(albumIds, 100)) {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA)
      .from("albums").select("id,name,artist_id,art_url").in("id", part);
    if (error) throw error;
    (data ?? []).forEach((row) =>
      albums.set(row.id, { name: row.name, artistId: row.artist_id, artUrl: row.art_url }));
  }
  const artistIds = [...new Set([...albums.values()].map((a) => a.artistId).filter(Boolean))] as string[];
  for (const part of chunk(artistIds, 100)) {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA)
      .from("artists").select("id,name").in("id", part);
    if (error) throw error;
    (data ?? []).forEach((row) => artists.set(row.id, row.name));
  }
  return { tracks, albums, artists };
}

export async function GET(req: NextRequest) {
  const sister = sisterB2RedirectUrl(req.nextUrl.host, req.nextUrl.pathname + req.nextUrl.search);
  if (sister) {
    return NextResponse.redirect(new URL(sister), {
      status: 307, headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  // A missing or stale session is not an error here: it just means the
  // artist half only, which is still worth having in the car.
  const user = await getAuthUser(req).catch(() => null);

  try {
    const sb = createSjServiceClient();
    const [artist, personal] = await Promise.all([
      artistSources(sb),
      user ? personalSources(sb, user.id) : Promise.resolve([] as Source[]),
    ]);
    // Your own copy wins over the artist's: it is the one you chose to keep.
    const byTrack = new Map<string, Source>();
    artist.forEach((s) => byTrack.set(s.trackId, s));
    personal.forEach((s) => byTrack.set(s.trackId, s));
    const sources = [...byTrack.values()];

    const { tracks, albums, artists } = await describe(sb, sources.map((s) => s.trackId));

    const urls = new Map<string, string>();
    for (const part of chunk(sources, B2_CONCURRENCY)) {
      const signed = await Promise.all(part.map((s) =>
        createB2DownloadUrl(s.storagePath, SIGNED_URL_SECONDS).catch(() => null)));
      part.forEach((s, i) => { if (signed[i]) urls.set(s.trackId, signed[i]!); });
    }
    // One bad object is skipped, but signing nothing at all means storage is
    // down or misconfigured. Answering "ok, empty" would wipe the car's last
    // good list, so fail and let it keep what it has.
    if (sources.length && !urls.size) throw new Error("Could not sign any CarPlay audio.");

    const items: LibraryTrack[] = sources.flatMap((s) => {
      const url = urls.get(s.trackId);
      const track = tracks.get(s.trackId);
      // A file with no catalogue row has nothing to call itself in the car.
      if (!url || !track) return [];
      const album = track.albumId ? albums.get(track.albumId) : null;
      return [{
        trackId: s.trackId,
        title: track.name || "Untitled",
        artist: (album?.artistId && artists.get(album.artistId)) || "Unknown Artist",
        album: album?.name || "",
        artworkUrl: absoluteArt(album?.artUrl),
        durationSeconds: s.duration || (track.durationMs ? track.durationMs / 1000 : 0),
        url,
        source: s.source,
      }];
    });

    return noStore({
      ok: true,
      signedIn: Boolean(user),
      expiresAt: Math.floor(Date.now() / 1000) + SIGNED_URL_SECONDS,
      tracks: items,
    });
  } catch (e) {
    console.error("[sj-carplay-library]", (e as Error).message);
    return noStore({ ok: false, error: "Could not load the CarPlay library." }, 500);
  }
}
