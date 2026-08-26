import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany, bad } from "@/lib/jukebox-request";
import { assertNoIpLeak } from "@/lib/spotify-history";
import { resolveSpotifyTracks } from "@/lib/spotify-history-match";

export const dynamic = "force-dynamic";

const MATCH_MAX = 500;
const IMPORT_MAX = 2000;
const HISTORY_BATCH_MAX = 500;
const HISTORY_TYPES = new Set(["music", "podcast", "audiobook", "other"]);

type CleanHistoryEvent = {
  user_id: string;
  event_fingerprint: string;
  content_type: string;
  spotify_uri: string | null;
  title: string;
  artist: string;
  album: string | null;
  played_at: string;
  duration_played_ms: number;
  skipped: boolean;
  source_file_name: string;
};

function cleanHistoryEvent(value: unknown, userId: string): CleanHistoryEvent | null {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const contentType = String(item.contentType || "").trim().toLowerCase();
  const playedAt = String(item.playedAt || "").trim();
  const playedAtMs = Date.parse(playedAt);
  const title = String(item.title || "").trim().slice(0, 500);
  const artist = String(item.artist || "").trim().slice(0, 500);
  if (!HISTORY_TYPES.has(contentType) || !Number.isFinite(playedAtMs) || !title || !artist) return null;
  const spotifyUri = String(item.uri || "").trim().slice(0, 256) || null;
  const album = String(item.album || "").trim().slice(0, 500) || null;
  const sourceFileName = String(item.fileName || "Spotify export").trim().slice(0, 500) || "Spotify export";
  const durationPlayedMs = Math.max(0, Math.min(Number(item.durationMs) || 0, 86_400_000));
  const skipped = item.skipped === true;
  const eventFingerprint = createHash("sha256")
    .update([contentType, spotifyUri || "", playedAt, durationPlayedMs, title, artist, album || ""].join("\0"))
    .digest("hex");
  return {
    user_id: userId,
    event_fingerprint: eventFingerprint,
    content_type: contentType,
    spotify_uri: spotifyUri,
    title,
    artist,
    album,
    played_at: new Date(playedAtMs).toISOString(),
    duration_played_ms: durationPlayedMs,
    skipped,
    source_file_name: sourceFileName,
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user?.email) return bad("Sign in to view your Spotify listening history.", 401);
    const sb = createSjServiceClient();
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .rpc("spotify_history_summary", { p_user_id: user.id });
    if (error) throw error;
    return NextResponse.json({ ok: true, summary: data ?? { events: 0, durationMs: 0, byType: {}, byYear: [], topArtists: [] } });
  } catch (error) {
    console.error("[spotify:history:summary]", error);
    return bad("Could not load your Spotify listening-history summary.", 502);
  }
}

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

    if (action === "import-history") {
      const events: unknown[] = Array.isArray(body.events) ? body.events.slice(0, HISTORY_BATCH_MAX) : [];
      if (!events.length) return bad("No history events to import.");
      const cleaned = events.map((event: unknown) => cleanHistoryEvent(event, user.id)).filter((event): event is CleanHistoryEvent => event !== null);
      if (!cleaned.length) return bad("No valid history events to import.");
      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("spotify_history_events")
        .upsert(cleaned, { onConflict: "user_id,event_fingerprint", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      const inserted = data?.length ?? 0;
      return NextResponse.json({ ok: true, inserted, skipped: cleaned.length - inserted });
    }

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
