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

type PlayerBody = {
  action?: string;
  uri?: string;
  uris?: string[];
  device_id?: string;
  position_ms?: number;
};

async function spotifyPlayerFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  return res;
}

export async function GET(req: NextRequest) {
  try {
    if (rateLimited(`spotify-player-get:${clientIp(req)}`, 60)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: false, error: "Connect Spotify first." }, { status: 401 });
    if (!canStream(found.session)) {
      return NextResponse.json({ ok: false, error: "Reconnect Spotify for playback.", reconnect: true }, { status: 403 });
    }
    const { session, refreshed } = await freshSpotifySession(found.session, found.config);
    const res = await spotifyPlayerFetch("/me/player/devices", session.accessToken);
    const data = res.ok ? await res.json() : { devices: [] };
    const response = NextResponse.json({ ok: true, devices: data.devices || [] });
    if (refreshed) {
      response.cookies.set(
        SPOTIFY_SESSION_COOKIE,
        sealSpotifySession(session, found.sealSecret),
        spotifyCookieOptions(req, 180 * 24 * 60 * 60),
      );
    }
    return response;
  } catch (error) {
    console.error("[spotify:player:get]", error);
    return NextResponse.json({ ok: false, error: "Could not list Spotify devices." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`spotify-player:${clientIp(req)}`, 90)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: false, error: "Connect Spotify first." }, { status: 401 });
    if (!canStream(found.session)) {
      return NextResponse.json({ ok: false, error: "Reconnect Spotify for playback.", reconnect: true }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as PlayerBody;
    const action = String(body.action || "");
    const { session, refreshed } = await freshSpotifySession(found.session, found.config);
    const token = session.accessToken;
    let res: Response;

    if (action === "transfer") {
      const deviceId = String(body.device_id || "");
      if (!deviceId) return NextResponse.json({ ok: false, error: "device_id required." }, { status: 400 });
      res = await spotifyPlayerFetch("/me/player", token, {
        method: "PUT",
        body: JSON.stringify({ device_ids: [deviceId], play: false }),
      });
    } else if (action === "play") {
      const uris = Array.isArray(body.uris)
        ? body.uris.filter((u) => typeof u === "string" && u.startsWith("spotify:"))
        : body.uri && String(body.uri).startsWith("spotify:")
          ? [String(body.uri)]
          : [];
      if (!uris.length) return NextResponse.json({ ok: false, error: "uri required." }, { status: 400 });
      const q = body.device_id ? `?device_id=${encodeURIComponent(String(body.device_id))}` : "";
      const payload: Record<string, unknown> = { uris };
      if (Number.isFinite(body.position_ms) && (body.position_ms as number) >= 0) {
        payload.position_ms = Math.floor(body.position_ms as number);
      }
      res = await spotifyPlayerFetch(`/me/player/play${q}`, token, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else if (action === "pause") {
      const q = body.device_id ? `?device_id=${encodeURIComponent(String(body.device_id))}` : "";
      res = await spotifyPlayerFetch(`/me/player/pause${q}`, token, { method: "PUT" });
    } else if (action === "seek") {
      const ms = Math.floor(Number(body.position_ms) || 0);
      const q = new URLSearchParams({ position_ms: String(Math.max(0, ms)) });
      if (body.device_id) q.set("device_id", String(body.device_id));
      res = await spotifyPlayerFetch(`/me/player/seek?${q}`, token, { method: "PUT" });
    } else {
      return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
    }

    // 204 = success for player endpoints; 404 = no active device yet.
    if (!res.ok && res.status !== 204) {
      const errBody = await res.text().catch(() => "");
      console.error("[spotify:player]", res.status, errBody);
      const response = NextResponse.json({
        ok: false,
        error: res.status === 404
          ? "No Spotify device is ready. Open Spotify on your phone or wait for the in-browser player."
          : "Spotify could not run that playback command.",
        status: res.status,
      }, { status: res.status === 404 ? 404 : 502 });
      if (refreshed) {
        response.cookies.set(
          SPOTIFY_SESSION_COOKIE,
          sealSpotifySession(session, found.sealSecret),
          spotifyCookieOptions(req, 180 * 24 * 60 * 60),
        );
      }
      return response;
    }

    const response = NextResponse.json({ ok: true });
    if (refreshed) {
      response.cookies.set(
        SPOTIFY_SESSION_COOKIE,
        sealSpotifySession(session, found.sealSecret),
        spotifyCookieOptions(req, 180 * 24 * 60 * 60),
      );
    }
    return response;
  } catch (error) {
    console.error("[spotify:player]", error);
    return NextResponse.json({ ok: false, error: "Spotify playback request failed." }, { status: 500 });
  }
}
