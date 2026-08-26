import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany, bad } from "@/lib/jukebox-request";
import { assertNoIpLeak } from "@/lib/spotify-history";
import { resolveSpotifyTracks } from "@/lib/spotify-history-match";

export const dynamic = "force-dynamic";

const MATCH_MAX = 500;
const IMPORT_MAX = 2000;

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`spotify-history:${clientIp(req)}`, 30)) return tooMany();
    const user = await getAuthUser(req);
    if (!user?.email) return bad("Sign in to import your Spotify listening history.", 401);

    const body = await req.json().catch(() => ({}));
    assertNoIpLeak(body);
    const action = String(body?.action || "import").trim();
    const sb = createSjServiceClient();
    const email = user.email.toLowerCase();

    if (action === "match") {
      const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, MATCH_MAX) : [];
      if (!tracks.length) return NextResponse.json({ ok: true, matches: [] });
      const matches = await resolveSpotifyTracks(sb, email, tracks);
      return NextResponse.json({ ok: true, matches });
    }

    if (action === "import") {
      const plays = Array.isArray(body.plays) ? body.plays.slice(0, IMPORT_MAX) : [];
      if (!plays.length) return bad("No plays to import.");
      const cleaned = plays.map((p: any) => ({
        track_id: String(p.track_id || p.trackId || "").trim(),
        artist_id: p.artist_id || p.artistId || null,
        album_id: p.album_id || p.albumId || null,
        played_at: String(p.played_at || p.playedAt || "").trim(),
        duration_played_ms: Number(p.duration_played_ms ?? p.durationPlayedMs) || null,
        spotify_track_uri: String(p.spotify_track_uri || p.uri || "").trim(),
      })).filter((p: any) => p.track_id && p.spotify_track_uri && p.played_at);

      if (!cleaned.length) return bad("No valid plays to import.");

      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("import_spotify_plays", {
        p_plays: cleaned,
        p_email: email,
      });
      if (error) throw error;
      return NextResponse.json({
        ok: true,
        inserted: data?.inserted ?? 0,
        skipped: data?.skipped ?? 0,
      });
    }

    return bad("Unknown action.");
  } catch (error: any) {
    if (error?.message?.includes("IP addresses")) return bad(error.message, 400);
    console.error("[spotify:history]", error);
    return bad("Could not process that Spotify history.", 502);
  }
}
