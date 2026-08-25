import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { readSpotifySession, refreshSpotifySession, sealSpotifySession, spotifyConfig, spotifyCookieOptions, SPOTIFY_SESSION_COOKIE, type SpotifySession } from "@/lib/spotify";

export const dynamic = "force-dynamic";
type SpotifyTrack = { id?: string; name?: string; uri?: string; artists?: Array<{ name?: string }>; album?: { name?: string; images?: Array<{ url?: string }> }; duration_ms?: number };

async function accessToken(session: SpotifySession, req: NextRequest) {
  if (session.expiresAt > Date.now() + 60_000) return { session, refreshed: false };
  return { session: await refreshSpotifySession(session, spotifyConfig(req)), refreshed: true };
}

export async function GET(req: NextRequest) {
  try {
    if (rateLimited(`spotify-library:${clientIp(req)}`, 30)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to import your Spotify music." }, { status: 401 });
    const config = spotifyConfig(req);
    const session = readSpotifySession(req.cookies.get(SPOTIFY_SESSION_COOKIE)?.value, config.clientSecret);
    if (!session || session.ownerId !== user.id) return NextResponse.json({ ok: false, error: "Connect Spotify to see your saved songs." }, { status: 401 });
    const token = await accessToken(session, req);
    const spotifyRes = await fetch("https://api.spotify.com/v1/me/tracks?limit=50", { headers: { Authorization: `Bearer ${token.session.accessToken}` }, cache: "no-store" });
    if (!spotifyRes.ok) throw new Error(`Spotify library request failed (${spotifyRes.status})`);
    const data = (await spotifyRes.json()) as { items?: Array<{ track?: SpotifyTrack }> };
    const tracks = (data.items ?? []).flatMap(({ track }) => {
      if (!track?.id || !track.name || !track.uri) return [];
      return [{ id: track.id, uri: track.uri, title: track.name, artistName: (track.artists ?? []).map((artist) => artist.name).filter(Boolean).join(", ") || "Unknown artist", albumName: track.album?.name || null, albumArtUrl: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null, durationMs: track.duration_ms ?? null }];
    });
    const response = NextResponse.json({ ok: true, tracks });
    if (token.refreshed) response.cookies.set(SPOTIFY_SESSION_COOKIE, sealSpotifySession(token.session, config.clientSecret), spotifyCookieOptions(req, 180 * 24 * 60 * 60));
    return response;
  } catch (error) {
    console.error("[spotify:library]", error);
    return NextResponse.json({ ok: false, error: "Could not load your saved Spotify songs." }, { status: 502 });
  }
}
