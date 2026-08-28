import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const SPOTIFY_SESSION_COOKIE = "sj_spotify_session";
export const SPOTIFY_STATE_COOKIE = "sj_spotify_state";

// Two Development-mode apps share the same redirect. Primary holds the original
// allowlist; backup is the overflow app for anyone Spotify refuses on primary.
export type SpotifyAppKey = "primary" | "backup";

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
  // Which dashboard app issued the tokens. Missing means primary - every
  // session sealed before the overflow app existed.
  app?: SpotifyAppKey;
};

export type SpotifyConfig = {
  app: SpotifyAppKey;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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

type SpotifyState = { state: string; ownerId: string; redirectUri: string; app: SpotifyAppKey };
type SpotifyTokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };

function redirectUriFor(req: NextRequest) {
  return process.env.SPOTIFY_REDIRECT_URI?.trim() || new URL("/api/spotify/callback", req.url).toString();
}

// Cookie crypto always uses the primary secret so a session survives switching
// apps and so existing cookies keep reading after the backup app was added.
export function spotifySealSecret() {
  const secret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!secret) throw new Error("Spotify is not configured yet.");
  return secret;
}

export function hasSpotifyBackup() {
  return !!(process.env.SPOTIFY_BACKUP_CLIENT_ID?.trim() && process.env.SPOTIFY_BACKUP_CLIENT_SECRET?.trim());
}

export function spotifyConfig(req: NextRequest, app: SpotifyAppKey = "primary"): SpotifyConfig {
  if (app === "backup") {
    const clientId = process.env.SPOTIFY_BACKUP_CLIENT_ID?.trim();
    const clientSecret = process.env.SPOTIFY_BACKUP_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error("Spotify backup is not configured yet.");
    return { app, clientId, clientSecret, redirectUri: redirectUriFor(req) };
  }
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Spotify is not configured yet.");
  return { app: "primary", clientId, clientSecret, redirectUri: redirectUriFor(req) };
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

// Starts (or restarts) the authorize hop for one dashboard app. Connect uses
// primary; the callback hops to backup when Spotify refuses a primary user.
export function beginSpotifyAuthorize(req: NextRequest, ownerId: string, app: SpotifyAppKey = "primary") {
  const config = spotifyConfig(req, app);
  const state = randomSpotifyState();
  const authorizationUrl = new URL("https://accounts.spotify.com/authorize");
  // show_dialog because Disconnect has to mean something. Without it Spotify
  // silently re-links the same account, so nobody could hand the panel a
  // different one - and a listener reconnecting for playlist permission would
  // never see what they were agreeing to.
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    state,
    show_dialog: "true",
  }).toString();
  const sealedState = sealSpotifyState(
    { state, ownerId, redirectUri: config.redirectUri, app },
    spotifySealSecret(),
  );
  return { authorizationUrl: authorizationUrl.toString(), sealedState, config };
}

export async function exchangeSpotifyCode(code: string, config: SpotifyConfig) {
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
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, scopes: token.scope || "", app: config.app };
}

export async function refreshSpotifySession(session: SpotifySession, config: SpotifyConfig) {
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
  return {
    ...session,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || session.refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: token.scope || session.scopes || "",
    app: config.app,
  };
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
  const sealSecret = spotifySealSecret();
  const session = readSpotifySession(req.cookies.get(SPOTIFY_SESSION_COOKIE)?.value, sealSecret);
  if (!session || session.ownerId !== ownerId) return null;
  const app: SpotifyAppKey = session.app === "backup" ? "backup" : "primary";
  return { config: spotifyConfig(req, app), session, sealSecret };
}

export async function freshSpotifySession(session: SpotifySession, config: SpotifyConfig) {
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
