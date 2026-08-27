import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const SPOTIFY_SESSION_COOKIE = "sj_spotify_session";
export const SPOTIFY_STATE_COOKIE = "sj_spotify_state";

export type SpotifySession = {
  ownerId: string;
  spotifyUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  // What Spotify actually granted, space separated, straight off the token
  // response. Sessions sealed before playlists existed carry no scopes at all,
  // which is why every reader treats a missing value as "saved songs only"
  // rather than as "everything".
  scopes?: string;
};

// Saved songs plus the two playlist reads. Nothing here touches playback, the
// account email, or anything we do not put on screen.
export const SPOTIFY_SCOPES = ["user-library-read", "playlist-read-private", "playlist-read-collaborative"];

export function sessionScopes(session: SpotifySession) {
  return (session.scopes || "user-library-read").split(/\s+/).filter(Boolean);
}

// A connection made before playlists shipped is still a valid connection - it
// just cannot see playlists. Say so rather than failing the whole panel.
export function canReadPlaylists(session: SpotifySession) {
  return sessionScopes(session).includes("playlist-read-private");
}

type SpotifyState = { state: string; ownerId: string; redirectUri: string };
type SpotifyTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };

export function spotifyConfig(req: NextRequest) {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Spotify is not configured yet.");
  return {
    clientId,
    clientSecret,
    // A dashboard-configured URI wins. The fallback makes localhost work while
    // keeping all credentials on the server.
    redirectUri: process.env.SPOTIFY_REDIRECT_URI?.trim() || new URL("/api/spotify/callback", req.url).toString(),
  };
}

function key(secret: string) { return createHash("sha256").update(secret).digest(); }

function seal(value: unknown, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function unseal<T>(value: string | undefined, secret: string): T | null {
  if (!value) return null;
  try {
    const [iv, tag, ciphertext] = value.split(".");
    if (!iv || !tag || !ciphertext) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
  } catch { return null; }
}

export function randomSpotifyState() { return randomBytes(32).toString("base64url"); }
export function sealSpotifyState(value: SpotifyState, secret: string) { return seal(value, secret); }
export function readSpotifyState(value: string | undefined, secret: string) { return unseal<SpotifyState>(value, secret); }
export function sealSpotifySession(value: SpotifySession, secret: string) { return seal(value, secret); }

export function readSpotifySession(value: string | undefined, secret: string): SpotifySession | null {
  const session = unseal<SpotifySession>(value, secret);
  if (!session || !session.ownerId || !session.spotifyUserId || !session.accessToken || !session.refreshToken || !Number.isFinite(session.expiresAt)) return null;
  return session;
}

export function stateMatches(expected: string, actual: string | null) {
  return !!actual && expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export async function exchangeSpotifyCode(code: string, config: ReturnType<typeof spotifyConfig>) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Spotify could not finish the connection.");
  const token = (await res.json()) as SpotifyTokenResponse;
  if (!token.access_token || !token.refresh_token || !token.expires_in) throw new Error("Spotify returned an incomplete connection.");
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, scopes: token.scope || "" };
}

export async function refreshSpotifySession(session: SpotifySession, config: ReturnType<typeof spotifyConfig>) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Your Spotify connection has expired. Connect Spotify again.");
  const token = (await res.json()) as SpotifyTokenResponse;
  if (!token.access_token || !token.expires_in) throw new Error("Spotify could not refresh the connection.");
  return { ...session, accessToken: token.access_token, refreshToken: token.refresh_token || session.refreshToken, expiresAt: Date.now() + token.expires_in * 1000, scopes: token.scope || session.scopes || "" };
}

export async function spotifyProfile(accessToken: string) {
  const res = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!res.ok) throw new Error("Spotify could not read your profile.");
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Spotify did not identify the connected account.");
  return data.id;
}


// ── Shared plumbing for the /api/spotify/* routes ────────────────────────────
// Every route needs the same three steps: unseal the cookie, check it belongs
// to the signed-in account, and refresh the token if it is about to expire.
// Doing it in one place is what keeps a new route from quietly skipping the
// ownership check.
export function spotifySessionFor(req: NextRequest, ownerId: string) {
  const config = spotifyConfig(req);
  const session = readSpotifySession(req.cookies.get(SPOTIFY_SESSION_COOKIE)?.value, config.clientSecret);
  if (!session || session.ownerId !== ownerId) return null;
  return { config, session };
}

export async function freshSpotifySession(session: SpotifySession, config: ReturnType<typeof spotifyConfig>) {
  if (session.expiresAt > Date.now() + 60_000) return { session, refreshed: false };
  return { session: await refreshSpotifySession(session, config), refreshed: true };
}

export async function spotifyApi<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    console.error(`[spotify:api] ${res.status} on ${url}:`, body);
    throw new SpotifyScopeError();
  }
  if (!res.ok) throw new Error(`Spotify request failed (${res.status})`);
  return (await res.json()) as T;
}

// Spotify answers "you never asked for this" with a 403, which is the one
// failure a listener can fix themselves - by connecting again and granting the
// playlist permission. It is worth its own error so the route can say that
// instead of "something went wrong".
export class SpotifyScopeError extends Error {
  constructor() { super("Reconnect Spotify to give us permission to read your playlists."); this.name = "SpotifyScopeError"; }
}

export function spotifyCookieOptions(req: NextRequest, maxAge: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: req.nextUrl.protocol === "https:", path: "/api/spotify", maxAge };
}
