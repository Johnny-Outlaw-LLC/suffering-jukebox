import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { beginSpotifyAuthorize, spotifyCookieOptions, SPOTIFY_STATE_COOKIE } from "@/lib/spotify";

export const dynamic = "force-dynamic";
// Saved songs and playlists are the only Spotify data this imports. No
// playback, no email, no follows, nothing beyond what the picker puts on
// screen. SPOTIFY_SCOPES is the single list, so the consent screen and the
// permission check can never drift apart.

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`spotify-connect:${clientIp(req)}`, 10)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to connect Spotify." }, { status: 401 });
    // Always start on the primary allowlist app. The callback hops to the
    // backup overflow app when Spotify refuses this account on primary.
    const started = beginSpotifyAuthorize(req, user.id, "primary");
    const response = NextResponse.json({ ok: true, authorizationUrl: started.authorizationUrl });
    response.cookies.set(SPOTIFY_STATE_COOKIE, started.sealedState, spotifyCookieOptions(req, 10 * 60));
    return response;
  } catch (error) {
    console.error("[spotify:connect]", error);
    return NextResponse.json({ ok: false, error: "Could not start the Spotify connection." }, { status: 500 });
  }
}
