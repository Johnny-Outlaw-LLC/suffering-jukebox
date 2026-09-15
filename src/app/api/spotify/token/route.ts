import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import {
  canStream,
  freshSpotifySession,
  sealSpotifySession,
  spotifyCookieOptions,
  spotifySessionFor,
  SPOTIFY_SESSION_COOKIE,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Short-lived access token for the Web Playback SDK getOAuthToken callback.
// The sealed refresh cookie never leaves the server.
export async function GET(req: NextRequest) {
  try {
    if (rateLimited(`spotify-token:${clientIp(req)}`, 60)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: false, error: "Connect Spotify first." }, { status: 401 });
    if (!canStream(found.session)) {
      return NextResponse.json({
        ok: false,
        error: "Reconnect Spotify to allow playback.",
        reconnect: true,
      }, { status: 403 });
    }

    const { session, refreshed } = await freshSpotifySession(found.session, found.config);
    const response = NextResponse.json({
      ok: true,
      access_token: session.accessToken,
      expires_at: session.expiresAt,
      expires_in: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
    });
    if (refreshed) {
      response.cookies.set(
        SPOTIFY_SESSION_COOKIE,
        sealSpotifySession(session, found.sealSecret),
        spotifyCookieOptions(req, 180 * 24 * 60 * 60),
      );
    }
    return response;
  } catch (error) {
    console.error("[spotify:token]", error);
    return NextResponse.json({ ok: false, error: "Could not refresh Spotify." }, { status: 500 });
  }
}
