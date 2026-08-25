import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import {
  canReadPlaylists,
  freshSpotifySession,
  sealSpotifySession,
  spotifyApi,
  spotifyCookieOptions,
  spotifySessionFor,
  SpotifyScopeError,
  SPOTIFY_SESSION_COOKIE,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

type SpotifyTrack = { id?: string; name?: string; uri?: string; artists?: Array<{ name?: string }>; album?: { name?: string; images?: Array<{ url?: string }> }; duration_ms?: number };
type SavedPage = { items?: Array<{ track?: SpotifyTrack }>; next?: string | null; total?: number };

// Four pages. Enough that a real library is worth browsing, small enough that
// the panel opens while somebody is still looking at it - and well inside the
// route's own time budget.
const PAGE = 50;
const MAX_PAGES = 4;

function shape(track: SpotifyTrack | undefined | null) {
  if (!track?.id || !track.name || !track.uri) return [];
  return [{
    id: track.id,
    uri: track.uri,
    title: track.name,
    artistName: (track.artists ?? []).map((artist) => artist.name).filter(Boolean).join(", ") || "Unknown artist",
    albumName: track.album?.name || null,
    albumArtUrl: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null,
    durationMs: track.duration_ms ?? null,
  }];
}

export async function GET(req: NextRequest) {
  try {
    if (rateLimited(`spotify-library:${clientIp(req)}`, 30)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to import your Spotify music." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: false, error: "Connect Spotify to see your saved songs." }, { status: 401 });

    // A playlist id turns this into "that playlist"; no id means saved songs.
    // One route, because the picker treats the two as one list of sources and
    // the shape it gets back has to be identical either way.
    const playlistId = new URL(req.url).searchParams.get("playlist")?.trim() || "";
    if (playlistId && !/^[A-Za-z0-9]+$/.test(playlistId)) return NextResponse.json({ ok: false, error: "That playlist could not be read." }, { status: 400 });
    if (playlistId && !canReadPlaylists(found.session)) throw new SpotifyScopeError();

    const token = await freshSpotifySession(found.session, found.config);
    const tracks: ReturnType<typeof shape> = [];
    let total = 0;
    let url = playlistId
      ? `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${PAGE}&fields=total,next,items(track(id,name,uri,duration_ms,artists(name),album(name,images)))`
      : `https://api.spotify.com/v1/me/tracks?limit=${PAGE}`;
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const data = await spotifyApi<SavedPage>(url, token.session.accessToken);
      if (typeof data.total === "number") total = data.total;
      (data.items ?? []).forEach(({ track }) => tracks.push(...shape(track)));
      url = data.next || "";
    }

    const response = NextResponse.json({ ok: true, tracks, total: total || tracks.length, truncated: !!url });
    if (token.refreshed) response.cookies.set(SPOTIFY_SESSION_COOKIE, sealSpotifySession(token.session, found.config.clientSecret), spotifyCookieOptions(req, 180 * 24 * 60 * 60));
    return response;
  } catch (error) {
    if (error instanceof SpotifyScopeError) return NextResponse.json({ ok: false, error: error.message, reconnect: true }, { status: 403 });
    console.error("[spotify:library]", error);
    return NextResponse.json({ ok: false, error: "Could not load those Spotify songs." }, { status: 502 });
  }
}
