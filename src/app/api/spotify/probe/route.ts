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

  const attempts: Array<[string, string]> = [
    ["playlistPlain", base],
    ["playlistFieldsTracks", `${base}?fields=tracks`],
    ["playlistFieldsTracksItems", `${base}?fields=tracks.items`],
    ["itemsPlain", `${base}/items?limit=3`],
    ["itemsAdditional", `${base}/items?limit=3&additional_types=track`],
    ["itemsMarket", `${base}/items?limit=3&market=from_token`],
    ["itemsFieldsItem", `${base}/items?limit=3&fields=${encodeURIComponent("total,next,items(item(id,name,uri,duration_ms,artists(name),album(name,images)))")}`],
    ["tracksAdditional", `${base}/tracks?limit=3&additional_types=track`],
    ["followers", `${base}/followers/contains?ids=${encodeURIComponent(found.session.spotifyUserId)}`],
  ];

  const results: Record<string, unknown> = {};
  for (const [name, url] of attempts) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
      const body = await res.text();
      results[name] = { status: res.status, body: body.slice(0, 2500) };
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
