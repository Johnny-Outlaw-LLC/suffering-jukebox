import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { randomSpotifyState, sealSpotifyState, spotifyConfig, spotifyCookieOptions, SPOTIFY_STATE_COOKIE } from "@/lib/spotify";

export const dynamic = "force-dynamic";
// Saved tracks are the only Spotify data this version imports. Ask for no
// playlist, playback, email, or profile scope beyond what that requires.
const SCOPES = ["user-library-read"];

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`spotify-connect:${clientIp(req)}`, 10)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to connect Spotify." }, { status: 401 });
    const config = spotifyConfig(req);
    const state = randomSpotifyState();
    const authorizationUrl = new URL("https://accounts.spotify.com/authorize");
    authorizationUrl.search = new URLSearchParams({ client_id: config.clientId, response_type: "code", redirect_uri: config.redirectUri, scope: SCOPES.join(" "), state }).toString();
    const response = NextResponse.json({ ok: true, authorizationUrl: authorizationUrl.toString() });
    response.cookies.set(SPOTIFY_STATE_COOKIE, sealSpotifyState({ state, ownerId: user.id, redirectUri: config.redirectUri }, config.clientSecret), spotifyCookieOptions(req, 10 * 60));
    return response;
  } catch (error) {
    console.error("[spotify:connect]", error);
    return NextResponse.json({ ok: false, error: "Could not start the Spotify connection." }, { status: 500 });
  }
}
