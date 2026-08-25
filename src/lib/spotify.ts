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
};

type SpotifyState = { state: string; ownerId: string; redirectUri: string };
type SpotifyTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

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
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 };
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
  return { ...session, accessToken: token.access_token, refreshToken: token.refresh_token || session.refreshToken, expiresAt: Date.now() + token.expires_in * 1000 };
}

export async function spotifyProfile(accessToken: string) {
  const res = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!res.ok) throw new Error("Spotify could not read your profile.");
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Spotify did not identify the connected account.");
  return data.id;
}

export function spotifyCookieOptions(req: NextRequest, maxAge: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: req.nextUrl.protocol === "https:", path: "/api/spotify", maxAge };
}
