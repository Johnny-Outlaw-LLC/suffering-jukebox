import { NextRequest, NextResponse } from "next/server";
import {
  beginSpotifyAuthorize,
  exchangeSpotifyCode,
  hasSpotifyBackup,
  readSpotifyState,
  sealSpotifySession,
  spotifyConfig,
  spotifyCookieOptions,
  spotifyProfile,
  spotifySealSecret,
  SPOTIFY_SESSION_COOKIE,
  SPOTIFY_STATE_COOKIE,
  stateMatches,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

function returnHome(req: NextRequest, outcome: "connected" | "denied") {
  const url = new URL("/", req.url);
  url.searchParams.set("spotify", outcome);
  return NextResponse.redirect(url);
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

  const app = saved.app === "backup" ? "backup" : "primary";
  const config = (() => { try { return spotifyConfig(req, app); } catch { return null; } })();
  if (!config || saved.redirectUri !== config.redirectUri) {
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }

  // Development-mode apps refuse anyone not on their allowlist with
  // access_denied. Hop once to the backup overflow app instead of failing.
  // A real Cancel on primary also lands here - they get one more consent
  // screen on backup, and a second Cancel still denies.
  if (error === "access_denied" && app === "primary" && hasSpotifyBackup()) {
    try {
      const started = beginSpotifyAuthorize(req, saved.ownerId, "backup");
      const response = NextResponse.redirect(started.authorizationUrl);
      response.cookies.set(SPOTIFY_STATE_COOKIE, started.sealedState, spotifyCookieOptions(req, 10 * 60));
      return response;
    } catch (err) {
      console.error("[spotify:callback:backup]", err);
    }
  }

  if (error || !code) {
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
    const response = returnHome(req, "denied");
    response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
    return response;
  }
}
