import { NextRequest, NextResponse } from "next/server";
import { exchangeSpotifyCode, readSpotifyState, sealSpotifySession, spotifyConfig, spotifyCookieOptions, spotifyProfile, SPOTIFY_SESSION_COOKIE, SPOTIFY_STATE_COOKIE, stateMatches } from "@/lib/spotify";

export const dynamic = "force-dynamic";

function returnHome(req: NextRequest, outcome: "connected" | "denied") {
  const url = new URL("/", req.url);
  url.searchParams.set("spotify", outcome);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const config = (() => { try { return spotifyConfig(req); } catch { return null; } })();
  if (!config) return returnHome(req, "denied");
  const saved = readSpotifyState(req.cookies.get(SPOTIFY_STATE_COOKIE)?.value, config.clientSecret);
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  if (!saved || !stateMatches(saved.state, state) || saved.redirectUri !== config.redirectUri || !code || req.nextUrl.searchParams.get("error")) {
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }
  try {
    const token = await exchangeSpotifyCode(code, config);
    const spotifyUserId = await spotifyProfile(token.accessToken);
    const response = returnHome(req, "connected");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    response.cookies.set(SPOTIFY_SESSION_COOKIE, sealSpotifySession({ ownerId: saved.ownerId, spotifyUserId, ...token }, config.clientSecret), spotifyCookieOptions(req, 180 * 24 * 60 * 60));
    return response;
  } catch (error) {
    console.error("[spotify:callback]", error);
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }
}
