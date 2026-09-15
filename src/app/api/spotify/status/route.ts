import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import {
  canReadPlaylists,
  canStream,
  freshSpotifySession,
  isSpotifyPremiumProduct,
  missingPlaybackScopes,
  sealSpotifySession,
  spotifyCookieOptions,
  spotifyProfile,
  spotifySessionFor,
  SPOTIFY_SESSION_COOKIE,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Cookie-only for the cheap path (?lite=1): My Jukebox opens often and only
 // needs connected + playlists. Full status hits /v1/me for Premium + scopes
 // when Settings or the player asks.
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to connect Spotify." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) {
      return NextResponse.json({
        ok: true,
        connected: false,
        spotifyUserId: null,
        canReadPlaylists: false,
        canStream: false,
        product: null,
        isPremium: false,
        missingPlaybackScopes: [],
        displayName: null,
      });
    }

    const lite = req.nextUrl.searchParams.get("lite") === "1";
    if (lite) {
      return NextResponse.json({
        ok: true,
        connected: true,
        spotifyUserId: found.session.spotifyUserId,
        canReadPlaylists: canReadPlaylists(found.session),
        canStream: canStream(found.session),
        product: null,
        isPremium: false,
        missingPlaybackScopes: missingPlaybackScopes(found.session),
        displayName: null,
      });
    }

    const { session, refreshed } = await freshSpotifySession(found.session, found.config);
    let product: string | null = null;
    let displayName: string | null = null;
    let isPremium = false;
    try {
      const me = await spotifyProfile(session.accessToken);
      product = me.product || null;
      displayName = me.display_name || null;
      isPremium = isSpotifyPremiumProduct(product);
    } catch (err) {
      console.error("[spotify:status:me]", err);
    }

    const response = NextResponse.json({
      ok: true,
      connected: true,
      spotifyUserId: session.spotifyUserId,
      canReadPlaylists: canReadPlaylists(session),
      canStream: canStream(session),
      product,
      isPremium,
      missingPlaybackScopes: missingPlaybackScopes(session),
      displayName,
    });
    if (refreshed) {
      response.cookies.set(
        SPOTIFY_SESSION_COOKIE,
        sealSpotifySession(session, found.sealSecret),
        spotifyCookieOptions(req, 180 * 24 * 60 * 60),
      );
    }
    return response;
  } catch {
    return NextResponse.json({
      ok: true,
      connected: false,
      spotifyUserId: null,
      canReadPlaylists: false,
      canStream: false,
      product: null,
      isPremium: false,
      missingPlaybackScopes: [],
      displayName: null,
    });
  }
}
