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

type PlaylistPage = {
  items?: Array<{ id?: string; name?: string; images?: Array<{ url?: string }>; owner?: { id?: string; display_name?: string }; tracks?: { total?: number } }>;
  next?: string | null;
};

const PAGE = 50;
const MAX_PAGES = 4;

export async function GET(req: NextRequest) {
  try {
    if (rateLimited(`spotify-playlists:${clientIp(req)}`, 30)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to import your Spotify music." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: false, error: "Connect Spotify to see your playlists." }, { status: 401 });
    if (!canReadPlaylists(found.session)) throw new SpotifyScopeError();

    const token = await freshSpotifySession(found.session, found.config);
    const playlists: Array<{ id: string; name: string; trackCount: number; imageUrl: string | null; ownerName: string | null; owned: boolean }> = [];
    let url = `https://api.spotify.com/v1/me/playlists?limit=${PAGE}`;
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const data = await spotifyApi<PlaylistPage>(url, token.session.accessToken);
      (data.items ?? []).forEach((item) => {
        if (!item?.id || !item.name) return;
        // Spotify only lets a Development-mode app read the contents of
        // playlists the connected account made itself. Somebody else's
        // playlist answers 403 no matter what we ask for, so the picker has
        // to know which is which before it offers one.
        playlists.push({ id: item.id, name: item.name, trackCount: item.tracks?.total ?? 0, imageUrl: item.images?.[0]?.url || null, ownerName: item.owner?.display_name || null, owned: !!item.owner?.id && item.owner.id === token.session.spotifyUserId });
      });
      url = data.next || "";
    }

    const response = NextResponse.json({ ok: true, playlists });
    if (token.refreshed) response.cookies.set(SPOTIFY_SESSION_COOKIE, sealSpotifySession(token.session, found.sealSecret), spotifyCookieOptions(req, 180 * 24 * 60 * 60));
    return response;
  } catch (error) {
    if (error instanceof SpotifyScopeError) return NextResponse.json({ ok: false, error: error.message, reconnect: true }, { status: 403 });
    console.error("[spotify:playlists]", error);
    return NextResponse.json({ ok: false, error: "Could not load your Spotify playlists." }, { status: 502 });
  }
}
