import { NextRequest, NextResponse } from "next/server";
import {
  beginSpotifyAuthorize,
  exchangeSpotifyCode,
  readSpotifyState,
  sealSpotifySession,
  spotifyConfig,
  spotifyCookieOptions,
  spotifyFallbackApp,
  spotifyProfile,
  spotifySealSecret,
  SPOTIFY_SESSION_COOKIE,
  SPOTIFY_STATE_COOKIE,
  stateMatches,
  type SpotifyAppKey,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

function returnHome(req: NextRequest, outcome: "connected" | "denied") {
  const url = new URL("/", req.url);
  url.searchParams.set("spotify", outcome);
  return NextResponse.redirect(url);
}

function hopToFallback(req: NextRequest, saved: { ownerId: string; app?: SpotifyAppKey; tried?: SpotifyAppKey[] }) {
  const next = spotifyFallbackApp(saved);
  if (!next) return null;
  const tried: SpotifyAppKey[] = [...new Set<SpotifyAppKey>([...(saved.tried || []), saved.app === "backup" ? "backup" : "primary", next])];
  const started = beginSpotifyAuthorize(req, saved.ownerId, next, tried);
  const response = NextResponse.redirect(started.authorizationUrl);
  response.cookies.set(SPOTIFY_STATE_COOKIE, started.sealedState, spotifyCookieOptions(req, 10 * 60));
  return response;
}

export async function GET(req: NextRequest) {
  const sealSecret = (() => { try { return spotifySealSecret(); } catch { return null; } })();
  if (!sealSecret) return returnHome(req, "denied");

  const saved = readSpotifyState(req.cookies.get(SPOTIFY_STATE_COOKIE)?.value, sealSecret);
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (!saved || !stateMatches(saved.state, state)) {
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }

  const app: SpotifyAppKey = saved.app === "backup" ? "backup" : "primary";
  const config = (() => { try { return spotifyConfig(req, app); } catch { return null; } })();
  if (!config || saved.redirectUri !== config.redirectUri) {
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }

  // Development-mode apps refuse allowlist misses with access_denied. Spotify
  // also sometimes hands back a code and then 403s /v1/me for the same reason.
  // Either way, hop once to the other dashboard app.
  if (error) {
    try {
      const hop = hopToFallback(req, saved);
      if (hop) return hop;
    } catch (err) {
      console.error("[spotify:callback:fallback]", err);
    }
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }

  if (!code) {
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }

  try {
    const token = await exchangeSpotifyCode(code, config);
    const spotifyUserId = await spotifyProfile(token.accessToken);
    const response = returnHome(req, "connected");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    response.cookies.set(
      SPOTIFY_SESSION_COOKIE,
      sealSpotifySession({ ownerId: saved.ownerId, spotifyUserId, ...token }, sealSecret),
      spotifyCookieOptions(req, 180 * 24 * 60 * 60),
    );
    return response;
  } catch (err) {
    console.error("[spotify:callback]", err);
    try {
      const hop = hopToFallback(req, saved);
      if (hop) return hop;
    } catch (hopErr) {
      console.error("[spotify:callback:fallback]", hopErr);
    }
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }
}
