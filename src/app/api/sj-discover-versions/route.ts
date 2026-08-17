// Search YouTube for other uploads of a song, and add one as an alternative
// version. Alternatives play from the Versions menu; they never become the
// default and they never count toward the YouTube bars.
import { NextRequest, NextResponse } from "next/server";
import {
  createSjServiceClient,
  fetchYouTubeVideoInfo,
  getAuthUser,
  parseYouTubeVideoId,
  searchYouTubeVideoIds,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";
import { labelForDiscoveredVideo, recordTrackVideo, thumbFor } from "@/lib/track-videos";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE_WINDOW_MS = 60_000;
const SEARCH_MAX = 8;
const ADD_MAX = 20;
const searchHits = new Map<string, number[]>();
const addHits = new Map<string, number[]>();

function rateLimited(map: Map<string, number[]>, key: string, max: number): boolean {
  const now = Date.now();
  const recent = (map.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  map.set(key, recent);
  if (map.size > 4000) {
    for (const [k, v] of map) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) map.delete(k);
    }
  }
  return recent.length > max;
}

function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}

function displayName(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  if (typeof meta.full_name === "string" && meta.full_name.trim()) return meta.full_name.trim();
  if (typeof meta.name === "string" && meta.name.trim()) return meta.name.trim();
  return null;
}

async function trackContext(trackId: string) {
  const sb = createSjServiceClient();
  const { data: track, error: tErr } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id, name, album_id")
    .eq("id", trackId)
    .maybeSingle();
  if (tErr || !track) return null;
  let artistName = "";
  let albumName = "";
  if (track.album_id) {
    const { data: album } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .select("id, name, artist_id")
      .eq("id", track.album_id)
      .maybeSingle();
    albumName = album?.name || "";
    if (album?.artist_id) {
      const { data: artist } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("artists")
        .select("id, name")
        .eq("id", album.artist_id)
        .maybeSingle();
      artistName = artist?.name || "";
    }
  }
  return { trackId: track.id as string, trackName: (track.name as string) || "", artistName, albumName };
}

function defaultQuery(ctx: { artistName: string; trackName: string }) {
  return [ctx.artistName, ctx.trackName].filter(Boolean).join(" ").trim();
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in to find alternative versions." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action === "add" ? "add" : "search";
  const trackId = uuid(body?.track_id);
  if (!trackId) {
    return NextResponse.json({ ok: false, error: "Invalid track." }, { status: 400 });
  }

  const ctx = await trackContext(trackId);
  if (!ctx) {
    return NextResponse.json({ ok: false, error: "Track not found." }, { status: 404 });
  }

  const who = user.email.toLowerCase();
  try {
    if (action === "search") return await searchAction(who, ctx, body);
    return await addAction(who, user, ctx, body);
  } catch (err) {
    console.error("[sj-discover-versions]", err);
    const msg = err instanceof Error ? err.message : "Could not talk to YouTube.";
    if (/not configured/i.test(msg)) {
      return NextResponse.json({ ok: false, error: "YouTube search is not configured." }, { status: 500 });
    }
    return NextResponse.json({ ok: false, error: "Could not search YouTube right now." }, { status: 500 });
  }
}

async function searchAction(
  who: string,
  ctx: NonNullable<Awaited<ReturnType<typeof trackContext>>>,
  body: Record<string, unknown>,
) {
  if (rateLimited(searchHits, who, SEARCH_MAX)) {
    return NextResponse.json({ ok: false, error: "Easy there — give the search a second." }, { status: 429 });
  }

  const raw = typeof body.query === "string" ? body.query.trim().slice(0, 160) : "";
  const query = raw || defaultQuery(ctx);
  if (!query) {
    return NextResponse.json({ ok: false, error: "Nothing to search for." }, { status: 400 });
  }

  const pasted = parseYouTubeVideoId(query);
  const ids = pasted ? [pasted] : await searchYouTubeVideoIds(query, 12);
  const info = ids.length ? await fetchYouTubeVideoInfo(ids) : {};

  const sb = createSjServiceClient();
  const { data: existing } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_videos")
    .select("video_id, is_primary, counts_for_charts, label")
    .eq("track_id", ctx.trackId);
  const have = new Map((existing ?? []).map((r) => [r.video_id as string, r]));

  const results = ids.map((id) => {
    const v = info[id];
    const row = have.get(id);
    return {
      videoId: id,
      title: v?.title || "",
      channel: v?.channelTitle || "",
      thumbnail: v?.thumbnail || thumbFor(id),
      views: v?.views ?? 0,
      likes: v?.likes ?? 0,
      playable: v ? v.playable : false,
      reason: v ? v.reason : "Video not found on YouTube",
      already: !!row,
      isPrimary: !!row?.is_primary,
      label: row?.label || labelForDiscoveredVideo(v?.title, v?.channelTitle, ctx.artistName),
    };
  });

  return NextResponse.json({
    ok: true,
    query,
    track: { id: ctx.trackId, name: ctx.trackName, artist: ctx.artistName, album: ctx.albumName },
    results,
  });
}

async function addAction(
  who: string,
  user: NonNullable<Awaited<ReturnType<typeof getAuthUser>>>,
  ctx: NonNullable<Awaited<ReturnType<typeof trackContext>>>,
  body: Record<string, unknown>,
) {
  if (rateLimited(addHits, who, ADD_MAX)) {
    return NextResponse.json({ ok: false, error: "Easy there — give adding a second." }, { status: 429 });
  }

  const videoId = parseYouTubeVideoId(typeof body.video_id === "string" ? body.video_id : "");
  if (!videoId) {
    return NextResponse.json({ ok: false, error: "Invalid video." }, { status: 400 });
  }

  const info = (await fetchYouTubeVideoInfo([videoId]))[videoId];
  if (!info) {
    return NextResponse.json({ ok: false, error: "That video is not on YouTube." }, { status: 404 });
  }
  if (!info.playable) {
    return NextResponse.json({
      ok: false,
      error: info.reason ? `That video will not play here (${info.reason}).` : "That video will not play here.",
    }, { status: 400 });
  }

  const sb = createSjServiceClient();
  const { data: already } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_videos")
    .select("video_id, title, channel, thumbnail, view_count, like_count, is_primary, is_playable, label, counts_for_charts")
    .eq("track_id", ctx.trackId)
    .eq("video_id", videoId)
    .maybeSingle();
  if (already) {
    return NextResponse.json({ ok: true, already: true, version: already });
  }

  const label = labelForDiscoveredVideo(info.title, info.channelTitle, ctx.artistName);
  await recordTrackVideo(
    sb,
    ctx.trackId,
    {
      videoId,
      title: info.title,
      channel: info.channelTitle,
      thumbnail: info.thumbnail,
      views: info.views,
      likes: info.likes,
      playable: true,
      label,
    },
    {
      makePrimary: false,
      source: "community",
      addedBy: user.email,
      addedByName: displayName(user.user_metadata as Record<string, unknown> | undefined),
      artistName: ctx.artistName,
      countsForCharts: false,
    },
  );

  const { data: saved } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_videos")
    .select("track_id, video_id, title, channel, thumbnail, view_count, like_count, lyric_offset_seconds, is_primary, is_playable, label, counts_for_charts")
    .eq("track_id", ctx.trackId)
    .eq("video_id", videoId)
    .maybeSingle();
  if (!saved) {
    return NextResponse.json({ ok: false, error: "Could not save that version." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    already: false,
    version: saved,
  });
}
