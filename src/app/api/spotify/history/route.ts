import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany, bad } from "@/lib/jukebox-request";
import { assertNoIpLeak } from "@/lib/spotify-history";
import { resolveSpotifyTracks } from "@/lib/spotify-history-match";

export const dynamic = "force-dynamic";
// Full GDPR exports are tens of thousands of rows; give the upsert room.
export const maxDuration = 60;

const MATCH_MAX = 500;
const IMPORT_MAX = 2000;
// 1,000 per call keeps payload size sane on Hobby while cutting round-trips
// for a ~25k-event export from ~50 down to ~25.
const HISTORY_BATCH_MAX = 1000;
const HISTORY_TYPES = new Set(["music", "podcast", "audiobook", "other"]);
const BUCKETS = new Set(["auto", "day", "week", "month", "year"]);
// A filter list of a few thousand names is a client bug, not a question worth
// answering; trim it rather than handing Postgres an unbounded array.
const FILTER_MAX = 2000;
const DATA_BATCH_MAX = 100;

function cleanDataBatches(value: unknown): Array<{ source: "spotify" | "youtube" | "jukebox"; year: number }> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const batches: Array<{ source: "spotify" | "youtube" | "jukebox"; year: number }> = [];
  for (const item of value) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const source = String(row.source || "").trim().toLowerCase();
    const year = Number(row.year);
    if ((source !== "spotify" && source !== "youtube" && source !== "jukebox") || !Number.isInteger(year) || year < 1900 || year > 2200) continue;
    const key = `${source}:${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    batches.push({ source, year });
    if (batches.length >= DATA_BATCH_MAX) break;
  }
  return batches;
}

function cleanFilterList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    const name = String(item ?? "").trim().slice(0, 1000);
    if (name) seen.add(name);
    if (seen.size >= FILTER_MAX) break;
  }
  // An explicit [] means "match no artists/songs". null means no filter.
  return [...seen];
}

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
  history_source: "spotify" | "youtube";
  youtube_video_id: string | null;
  youtube_url: string | null;
  youtube_channel: string | null;
  classification_confidence: string | null;
  classification_reason: string | null;
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
  const sourceFileName = String(item.fileName || (item.source === "youtube" ? "YouTube watch-history.html" : "Spotify export")).trim().slice(0, 500) || "Listening history export";
  const durationPlayedMs = Math.max(0, Math.min(Number(item.durationMs) || 0, 86_400_000));
  const skipped = item.skipped === true;
  const historySource = item.source === "youtube" ? "youtube" : "spotify";
  const youtubeVideoId = historySource === "youtube" ? String(item.videoId || "").trim().slice(0, 32) || null : null;
  const youtubeUrl = youtubeVideoId ? `https://www.youtube.com/watch?v=${youtubeVideoId}` : null;
  const youtubeChannel = historySource === "youtube" ? String(item.channel || "").trim().slice(0, 500) || null : null;
  const confidenceRaw = String(item.confidence || "").trim().toLowerCase();
  const classificationConfidence = historySource === "youtube" && ["high", "likely", "uncertain"].includes(confidenceRaw) ? confidenceRaw : null;
  const classificationReason = historySource === "youtube" ? String(item.reason || "").trim().slice(0, 500) || null : null;
  if (historySource === "youtube" && !youtubeVideoId) return null;
  const fingerprintParts = historySource === "youtube"
    ? [historySource, contentType, youtubeVideoId || "", playedAt, durationPlayedMs, title, artist, album || ""]
    : [contentType, spotifyUri || "", playedAt, durationPlayedMs, title, artist, album || ""];
  const eventFingerprint = createHash("sha256")
    .update(fingerprintParts.join("\0"))
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
    history_source: historySource,
    youtube_video_id: youtubeVideoId,
    youtube_url: youtubeUrl,
    youtube_channel: youtubeChannel,
    classification_confidence: classificationConfidence,
    classification_reason: classificationReason,
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
    const user = await getAuthUser(req);
    if (!user?.email) return bad("Sign in to import your Spotify listening history.", 401);

    const body = await req.json().catch(() => ({}));
    assertNoIpLeak(body);
    const action = String(body?.action || "import").trim();
    const sb = createSjServiceClient();
    const email = user.email.toLowerCase();
    const uid = user.id;

    if (action === "data-batches") {
      if (rateLimited(`listening-data-batches:${uid}`, 60, 60_000)) return tooMany();
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("listening_data_batches", { p_user_id: uid });
      if (error) throw error;
      return NextResponse.json({ ok: true, data: data ?? { batches: [] } });
    }

    if (action === "set-insights-consent") {
      if (rateLimited(`listening-insights-consent:${uid}`, 12, 60_000)) return tooMany();
      const { error } = await sb.schema(JUKEBOX_SCHEMA).rpc("set_listening_insights_consent", {
        p_user_id: uid,
        p_contribute_spotify_history: body.contributeSpotifyHistoryInsights === true,
        p_policy_version: String(body.policyVersion || "").trim().slice(0, 64) || "2026-08-29.1",
      });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (action === "archive-data-batches" || action === "restore-data-batches") {
      if (rateLimited(`listening-data-update:${uid}`, 12, 60_000)) return tooMany();
      const batches = cleanDataBatches(body.batches);
      if (!batches.length) return bad("Choose at least one year and source.");
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("set_listening_data_archive", {
        p_user_id: uid,
        p_batches: batches,
        p_archive: action === "archive-data-batches",
      });
      if (error) throw error;
      const { data: refreshed, error: refreshError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .rpc("listening_data_batches", { p_user_id: uid });
      if (refreshError) throw refreshError;
      return NextResponse.json({ ok: true, result: data ?? { records: 0 }, data: refreshed ?? { batches: [] } });
    }

    // Analytics is a POST because the artist and song filters are multi-select
    // and a long selection does not survive a query string.
    if (action === "analytics") {
      if (rateLimited(`listening-analytics:${uid}`, 240, 60_000)) return tooMany();
      const sourceRaw = String(body.source || "all").trim().toLowerCase();
      const source = sourceRaw === "jukebox" || sourceRaw === "spotify" ? sourceRaw : "all";
      const bucketRaw = String(body.bucket || "auto").trim().toLowerCase();
      const bucket = BUCKETS.has(bucketRaw) ? bucketRaw : "auto";
      const fromMs = body.from ? Date.parse(String(body.from)) : NaN;
      const toMs = body.to ? Date.parse(String(body.to)) : NaN;
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("listening_analytics", {
        p_user_id: uid,
        p_tz: String(body.tz || "America/Chicago").slice(0, 64),
        p_source: source,
        p_from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
        p_to: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null,
        p_artists: cleanFilterList(body.artists),
        p_artists_mode: body.artistsMode === "exclude" ? "exclude" : "include",
        p_tracks: cleanFilterList(body.tracks),
        p_tracks_mode: body.tracksMode === "exclude" ? "exclude" : "include",
        p_bucket: bucket,
      });
      if (error) throw error;
      return NextResponse.json({ ok: true, analytics: data ?? null });
    }

    if (action === "import-history") {
      // Signed-in GDPR imports are large and deliberate. Cap by user, not IP, and
      // allow enough batches for a multi-year Extended Streaming History dump
      // (~250k events at HISTORY_BATCH_MAX) inside a 15-minute window.
      if (rateLimited(`listening-history-import:${uid}`, 300, 15 * 60_000)) return tooMany();
      const events: unknown[] = Array.isArray(body.events) ? body.events.slice(0, HISTORY_BATCH_MAX) : [];
      if (!events.length) return bad("No history events to import.");
      const cleaned = events
        .map((event: unknown) => cleanHistoryEvent(event, user.id))
        .filter((event): event is CleanHistoryEvent => event !== null);
      // Same listen twice in one batch (overlapping export files) must not trip
      // the unique index mid-statement — keep the first, drop the rest.
      const byFingerprint = new Map<string, CleanHistoryEvent>();
      for (const event of cleaned) {
        if (!byFingerprint.has(event.event_fingerprint)) byFingerprint.set(event.event_fingerprint, event);
      }
      const unique = [...byFingerprint.values()];
      if (!unique.length) return bad("No valid history events to import.");
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("import_spotify_history_events", {
        p_user_id: user.id,
        p_events: unique.map((event) => ({
          event_fingerprint: event.event_fingerprint,
          content_type: event.content_type,
          spotify_uri: event.spotify_uri,
          title: event.title,
          artist: event.artist,
          album: event.album,
          played_at: event.played_at,
          duration_played_ms: event.duration_played_ms,
          skipped: event.skipped,
          source_file_name: event.source_file_name,
          history_source: event.history_source,
          youtube_video_id: event.youtube_video_id,
          youtube_url: event.youtube_url,
          youtube_channel: event.youtube_channel,
          classification_confidence: event.classification_confidence,
          classification_reason: event.classification_reason,
        })),
      });
      if (error) throw error;
      const inserted = Number(data?.inserted || 0);
      const skipped = Number(data?.skipped || Math.max(0, unique.length - inserted));
      return NextResponse.json({
        ok: true,
        inserted,
        skipped,
        // Rows collapsed inside this batch before the DB saw them.
        batchDuplicates: Math.max(0, cleaned.length - unique.length),
        batchMax: HISTORY_BATCH_MAX,
      });
    }

    if (action === "match") {
      if (rateLimited(`spotify-history-match:${uid}`, 60) || rateLimited(`spotify-history-ip:${clientIp(req)}`, 90)) {
        return tooMany();
      }
      const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, MATCH_MAX) : [];
      if (!tracks.length) return NextResponse.json({ ok: true, matches: [] });
      const matches = await resolveSpotifyTracks(sb, email, tracks);
      return NextResponse.json({ ok: true, matches });
    }

    if (action === "import") {
      if (rateLimited(`spotify-history-plays:${uid}`, 60) || rateLimited(`spotify-history-ip:${clientIp(req)}`, 90)) {
        return tooMany();
      }
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
