import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  createSjServiceClient,
  fetchYouTubeVideoStats,
  parseYouTubeVideoId,
  verifySjAdmin,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

type MetricRow = {
  id: string;
  metric_name: string;
  metric_value: number | null;
  metric_text_value: string | null;
  metric_date: string;
};

async function latestMetricsByTrack(trackIds: string[]) {
  if (!trackIds.length) return {};

  const sb = createSjServiceClient();
  const map: Record<string, Record<string, string | number | null>> = {};
  const chunkSize = 80;

  for (let i = 0; i < trackIds.length; i += chunkSize) {
    const chunk = trackIds.slice(i, i + chunkSize);
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("metrics")
      .select("track_id, metric_name, metric_value, metric_text_value, metric_date")
      .eq("metric_source", "youtube")
      .in("track_id", chunk);
    if (error) throw error;

    for (const row of data ?? []) {
      if (!row.track_id) continue;
      if (!map[row.track_id]) map[row.track_id] = {};
      const cur = map[row.track_id][row.metric_name];
      if (!cur) {
        map[row.track_id][row.metric_name] =
          row.metric_name === "youtube_video_id" || row.metric_name === "youtube_thumbnail"
            ? row.metric_text_value
            : row.metric_value;
        map[row.track_id][`${row.metric_name}_date`] = row.metric_date;
      }
    }
  }

  return map;
}

export async function GET(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;

  const trackId = req.nextUrl.searchParams.get("track_id");
  const sb = createSjServiceClient();

  if (trackId) {
    const [{ data: track, error: trackErr }, { data: album, error: albErr }] = await Promise.all([
      sb.schema(JUKEBOX_SCHEMA).from("tracks").select("*").eq("id", trackId).maybeSingle(),
      sb.schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("album_id")
        .eq("id", trackId)
        .maybeSingle()
        .then(async (t) => {
          if (!t.data?.album_id) return { data: null, error: t.error };
          return sb
            .schema(JUKEBOX_SCHEMA)
            .from("albums")
            .select("id, name, release_date, artist_id")
            .eq("id", t.data.album_id)
            .maybeSingle();
        }),
    ]);
    if (trackErr || !track) {
      return NextResponse.json({ ok: false, error: "Track not found." }, { status: 404 });
    }
    if (albErr) console.error("[sj-admin-songs:album]", albErr);

    const { data: metrics, error: metErr } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("metrics")
      .select("id, metric_name, metric_value, metric_text_value, metric_date, metric_source, pull_id")
      .eq("track_id", trackId)
      .order("metric_date", { ascending: false });
    if (metErr) {
      return NextResponse.json({ ok: false, error: "Could not load metrics." }, { status: 500 });
    }

    const ytMetrics = (metrics ?? []).filter((m) => m.metric_source === "youtube");
    const latest: Record<string, unknown> = {};
    for (const row of ytMetrics) {
      if (latest[row.metric_name]) continue;
      latest[row.metric_name] =
        row.metric_name === "youtube_video_id" || row.metric_name === "youtube_thumbnail"
          ? row.metric_text_value
          : row.metric_value;
      latest[`${row.metric_name}_date`] = row.metric_date;
    }

    const { data: lyrics } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("lyrics")
      .select("lyrics, lyrics_source, lyrics_saved_at")
      .eq("track_id", trackId)
      .maybeSingle();

    return NextResponse.json({
      ok: true,
      track,
      album,
      youtube: latest,
      metrics: metrics ?? [],
      lyrics: lyrics ?? null,
    });
  }

  const [{ data: albums, error: albumsErr }, { data: tracks, error: tracksErr }, { data: artists }] =
    await Promise.all([
      sb
        .schema(JUKEBOX_SCHEMA)
        .from("albums")
        .select("id, name, release_date, artist_id")
        .order("release_date", { ascending: true }),
      sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("id, name, album_id, track_number, duration_ms")
        .order("track_number", { ascending: true }),
      sb.schema(JUKEBOX_SCHEMA).from("artists").select("id, name"),
    ]);

  if (albumsErr || tracksErr) {
    return NextResponse.json({ ok: false, error: "Could not load catalog." }, { status: 500 });
  }

  const artistMap = Object.fromEntries((artists ?? []).map((a) => [a.id, a.name]));
  let ytMap: Record<string, Record<string, string | number | null>> = {};
  try {
    ytMap = await latestMetricsByTrack((tracks ?? []).map((t) => t.id));
  } catch (err) {
    console.error("[sj-admin-songs:metrics]", err);
  }

  const catalog = (albums ?? []).map((alb) => ({
    ...alb,
    artist_name: artistMap[alb.artist_id] ?? "",
    tracks: (tracks ?? [])
      .filter((t) => t.album_id === alb.id)
      .map((t) => ({
        ...t,
        video_id: ytMap[t.id]?.youtube_video_id ?? null,
        views: ytMap[t.id]?.youtube_views ?? null,
      })),
  }));

  return NextResponse.json({ ok: true, catalog });
}

export async function PATCH(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;

  const body = await req.json();
  const trackId = String(body.track_id || "").trim();
  const youtubeInput = String(body.youtube_url ?? body.video_id ?? "").trim();
  if (!trackId || !youtubeInput) {
    return NextResponse.json({ ok: false, error: "Track ID and YouTube link required." }, { status: 400 });
  }

  const videoId = parseYouTubeVideoId(youtubeInput);
  if (!videoId) {
    return NextResponse.json({ ok: false, error: "Invalid YouTube URL or video ID." }, { status: 400 });
  }

  const sb = createSjServiceClient();
  const { data: track, error: trackErr } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id, album_id, name")
    .eq("id", trackId)
    .maybeSingle();
  if (trackErr || !track) {
    return NextResponse.json({ ok: false, error: "Track not found." }, { status: 404 });
  }

  let stats;
  try {
    stats = await fetchYouTubeVideoStats(videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "YouTube lookup failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const syncRunId = randomUUID();
  const now = new Date().toISOString();
  const { error: runErr } = await sb.schema(JUKEBOX_SCHEMA).from("sync_runs").insert({
    id: syncRunId,
    pulled_at: now,
    source: "youtube_manual",
    album_count: 1,
    track_count: 1,
    notes: `Manual YouTube link update by ${auth.user.email}`,
  });
  if (runErr) {
    console.error("[sj-admin-songs:sync_run]", runErr);
    return NextResponse.json({ ok: false, error: "Could not create sync run." }, { status: 500 });
  }

  const metricRows = [
    {
      id: randomUUID(),
      pull_id: syncRunId,
      metric_name: "youtube_video_id",
      metric_value: null,
      metric_text_value: videoId,
      metric_source: "youtube",
      metric_date: now,
      metric_type: "track",
      track_id: trackId,
      album_id: track.album_id,
      artist_id: null,
    },
    {
      id: randomUUID(),
      pull_id: syncRunId,
      metric_name: "youtube_views",
      metric_value: stats.views,
      metric_text_value: null,
      metric_source: "youtube",
      metric_date: now,
      metric_type: "track",
      track_id: trackId,
      album_id: track.album_id,
      artist_id: null,
    },
    {
      id: randomUUID(),
      pull_id: syncRunId,
      metric_name: "youtube_likes",
      metric_value: stats.likes,
      metric_text_value: null,
      metric_source: "youtube",
      metric_date: now,
      metric_type: "track",
      track_id: trackId,
      album_id: track.album_id,
      artist_id: null,
    },
    {
      id: randomUUID(),
      pull_id: syncRunId,
      metric_name: "youtube_thumbnail",
      metric_value: null,
      metric_text_value: stats.thumbnail,
      metric_source: "youtube",
      metric_date: now,
      metric_type: "track",
      track_id: trackId,
      album_id: track.album_id,
      artist_id: null,
    },
  ];

  const { error: insertErr } = await sb.schema(JUKEBOX_SCHEMA).from("metrics").insert(metricRows);
  if (insertErr) {
    console.error("[sj-admin-songs:metrics]", insertErr);
    return NextResponse.json({ ok: false, error: "Could not save metrics." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    track_id: trackId,
    video_id: videoId,
    views: stats.views,
    likes: stats.likes,
    thumbnail: stats.thumbnail,
  });
}
