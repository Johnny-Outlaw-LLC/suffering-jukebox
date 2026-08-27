import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import {
  freshSpotifySession,
  sessionScopes,
  spotifySessionFor,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Temporary diagnostic. Runs the same read several ways with the listener's
// real token and reports what Spotify says to each, so a 403 stops being a
// guess. Delete once the playlist import is fixed.
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "sign in" }, { status: 401 });
  const found = spotifySessionFor(req, user.id);
  if (!found) return NextResponse.json({ ok: false, error: "connect spotify" }, { status: 401 });
  const playlistId = new URL(req.url).searchParams.get("playlist")?.trim() || "";
  if (!playlistId) return NextResponse.json({ ok: false, error: "pass ?playlist=" }, { status: 400 });

  const token = await freshSpotifySession(found.session, found.config);
  const access = token.session.accessToken;
  const base = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`;
  const fields = "total,next,items(track(id,name,uri,duration_ms,artists(name),album(name,images)))";

  const attempts: Array<[string, string]> = [
    ["me", "https://api.spotify.com/v1/me"],
    ["saved", "https://api.spotify.com/v1/me/tracks?limit=1"],
    ["myPlaylists", "https://api.spotify.com/v1/me/playlists?limit=1"],
    ["playlistObject", base],
    ["playlistObjectFields", `${base}?fields=id,name,owner(id,display_name),public,collaborative,tracks(total)`],
    ["playlistNestedTracks", `${base}?fields=tracks(total,next,items(track(id,name,uri,duration_ms,artists(name),album(name,images))))`],
    ["tracksPlain", `${base}/tracks?limit=5`],
    ["tracksFields", `${base}/tracks?limit=5&fields=${encodeURIComponent(fields)}`],
    ["tracksMarket", `${base}/tracks?limit=5&market=US`],
    ["tracksMarketFromToken", `${base}/tracks?limit=5&market=from_token`],
    ["itemsPlain", `${base}/items?limit=5`],
    ["itemsFields", `${base}/items?limit=5&fields=${encodeURIComponent(fields)}`],
  ];

  const results: Record<string, unknown> = {};
  for (const [name, url] of attempts) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
      const body = await res.text();
      results[name] = { status: res.status, body: body.slice(0, 400) };
    } catch (error) {
      results[name] = { status: "threw", body: String(error).slice(0, 200) };
    }
  }

  return NextResponse.json({
    ok: true,
    playlistId,
    scopes: sessionScopes(token.session),
    spotifyUserId: token.session.spotifyUserId,
    refreshed: token.refreshed,
    results,
  });
}
