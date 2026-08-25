import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { randomSpotifyState, sealSpotifyState, spotifyConfig, spotifyCookieOptions, SPOTIFY_SCOPES, SPOTIFY_STATE_COOKIE } from "@/lib/spotify";

export const dynamic = "force-dynamic";
// Saved songs and playlists are the only Spotify data this imports. No
// playback, no email, no follows, nothing beyond what the picker puts on
// screen. SPOTIFY_SCOPES is the single list, so the consent screen and the
// permission check can never drift apart.
const SCOPES = SPOTIFY_SCOPES;

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`spotify-connect:${clientIp(req)}`, 10)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to connect Spotify." }, { status: 401 });
    const config = spotifyConfig(req);
    const state = randomSpotifyState();
    // show_dialog because Disconnect has to mean something. Without it Spotify
    // silently re-links the same account, so nobody could hand the panel a
    // different one - and a listener reconnecting for playlist permission would
    // never see what they were agreeing to.
    const authorizationUrl = new URL("https://accounts.spotify.com/authorize");
    authorizationUrl.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri, scope: SCOPES.join(" "), state, show_dialog: "true" }).toString();
    const response = NextResponse.json({ ok: true, authorizationUrl: authorizationUrl.toString() });
    response.cookies.set(SPOTIFY_STATE_COOKIE, sealSpotifyState({ state, ownerId: user.id, redirectUri: config.redirectUri }, config.clientSecret), spotifyCookieOptions(req, 10 * 60));
    return response;
  } catch (error) {
    console.error("[spotify:connect]", error);
    return NextResponse.json({ ok: false, error: "Could not start the Spotify connection." }, { status: 500 });
  }
}
