import { NextRequest, NextResponse } from "next/server";
import {
  createSjServiceClient,
  getAuthUser,
  isSjAdmin,
  parseYouTubeVideoId,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";
import { recordTrackVideo, thumbFor } from "@/lib/track-videos";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFICIAL_MANAGE_SLUGS = new Set(["silver-jews", "purple-mountains"]);
const OFFICIAL_OWNER = "johnnyoutlawllc@gmail.com";

type TrackCtx = {
  track: {
    id: string;
    name: string;
    album_id: string;
    track_number: number | null;
    visibility: string | null;
    duration_ms: number | null;
  };
  album: { id: string; name: string; artist_id: string; added_by: string | null };
  artist: { id: string; name: string; slug: string | null; added_by: string | null; is_community: boolean | null };
};

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}

async function loadTrackCtx(trackId: string): Promise<TrackCtx | null> {
  const sb = createSjServiceClient();
  const { data: track } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id,name,album_id,track_number,visibility,duration_ms")
    .eq("id", trackId)
    .maybeSingle();
  if (!track?.album_id) return null;
  const { data: album } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id,name,artist_id,added_by")
    .eq("id", track.album_id)
    .maybeSingle();
  if (!album?.artist_id) return null;
  const { data: artist } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id,name,slug,added_by,is_community")
    .eq("id", album.artist_id)
    .maybeSingle();
  if (!artist) return null;
  return {
    track: track as TrackCtx["track"],
    album: album as TrackCtx["album"],
    artist: artist as TrackCtx["artist"],
  };
}

async function canManage(email: string, ctx: TrackCtx): Promise<boolean> {
  const e = email.toLowerCase();
  if (await isSjAdmin(email)) return true;
  if ((ctx.artist.added_by || "").toLowerCase() === e) return true;
  if ((ctx.album.added_by || "").toLowerCase() === e) return true;
  if (OFFICIAL_MANAGE_SLUGS.has(ctx.artist.slug || "") && e === OFFICIAL_OWNER) return true;
  return false;
}

async function requireManage(req: NextRequest, trackId: string) {
  const user = await getAuthUser(req);
  if (!user?.email) return { error: bad("Sign in required.", 401) };
  const ctx = await loadTrackCtx(trackId);
  if (!ctx) return { error: bad("Track not found.", 404) };
  if (!(await canManage(user.email, ctx))) {
    return { error: bad("You can only manage songs you imported.", 403) };
  }
  return { user, ctx };
}

export async function GET(req: NextRequest) {
  const trackId = uuid(req.nextUrl.searchParams.get("track_id"));
  if (!trackId) return bad("track_id required.");
  const gate = await requireManage(req, trackId);
  if ("error" in gate) return gate.error;
  const { ctx } = gate;
  const sb = createSjServiceClient();

  const [{ data: albums }, { data: videos }, { data: links }] = await Promise.all([
    sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .select("id,name,release_date")
      .eq("artist_id", ctx.artist.id)
      .order("release_date", { ascending: true, nullsFirst: false }),
    sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .select(
        "video_id,title,channel,thumbnail,view_count,is_primary,is_playable,label,counts_for_charts"
      )
      .eq("track_id", trackId)
      .order("view_count", { ascending: false, nullsFirst: false }),
    sb
      .schema(JUKEBOX_SCHEMA)
      .from("links")
      .select("id,link_name,url,link_priority")
      .eq("track_id", trackId)
      .order("link_priority", { ascending: true }),
  ]);

  return NextResponse.json({
    ok: true,
    track: ctx.track,
    album: { id: ctx.album.id, name: ctx.album.name },
    artist: { id: ctx.artist.id, name: ctx.artist.name, slug: ctx.artist.slug },
    albums: albums || [],
    videos: videos || [],
    links: links || [],
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return bad("Invalid JSON.");
  }
  const action = typeof body.action === "string" ? body.action : "";
  const trackId = uuid(body.track_id);
  if (!trackId) return bad("track_id required.");
  const gate = await requireManage(req, trackId);
  if ("error" in gate) return gate.error;
  const { user, ctx } = gate;
  const sb = createSjServiceClient();

  if (action === "save") {
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim().slice(0, 200);
      if (!name) return bad("Song name cannot be empty.");
      if (name !== ctx.track.name) patch.name = name;
    }
    if (typeof body.visibility === "string") {
      const vis = body.visibility === "private" ? "private" : "public";
      if (vis !== (ctx.track.visibility || "public")) patch.visibility = vis;
    }

    let movedFrom: { albumId: string; trackNumber: number | null } | null = null;
    if (typeof body.album_id === "string" && body.album_id !== ctx.track.album_id) {
      const destId = uuid(body.album_id);
      if (!destId) return bad("Invalid album.");
      const { data: dest } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("albums")
        .select("id,artist_id")
        .eq("id", destId)
        .maybeSingle();
      if (!dest) return bad("Album not found.", 404);
      if (dest.artist_id !== ctx.artist.id) {
        return bad("Songs can only move between albums by the same artist.");
      }
      const { data: siblings } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("track_number")
        .eq("album_id", destId)
        .order("track_number", { ascending: false })
        .limit(1);
      patch.album_id = destId;
      patch.track_number = ((siblings?.[0]?.track_number as number) || 0) + 1;
      movedFrom = { albumId: ctx.track.album_id, trackNumber: ctx.track.track_number };
    }

    if (Object.keys(patch).length) {
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("tracks").update(patch).eq("id", trackId);
      if (error) return bad(error.message || "Could not save.", 500);
    }

    if (movedFrom?.trackNumber != null) {
      const { data: rest } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("id,track_number")
        .eq("album_id", movedFrom.albumId)
        .gt("track_number", movedFrom.trackNumber)
        .order("track_number", { ascending: true });
      for (const row of rest || []) {
        await sb
          .schema(JUKEBOX_SCHEMA)
          .from("tracks")
          .update({ track_number: (row.track_number as number) - 1 })
          .eq("id", row.id);
      }
    }

    if (patch.visibility === "private" && user.email) {
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("content_access")
        .upsert(
          { artist_id: ctx.artist.id, user_email: user.email.toLowerCase() },
          { onConflict: "artist_id,user_email", ignoreDuplicates: true }
        );
    }

    const fresh = await loadTrackCtx(trackId);
    return NextResponse.json({ ok: true, track: fresh?.track || { id: trackId, ...patch } });
  }

  if (action === "delete") {
    const tables = [
      "metrics",
      "lyrics",
      "lyrics_edits",
      "playlist_tracks",
      "yt_daily_snapshots",
      "track_play_counts",
      "play_events",
      "rating_events",
      "feedback",
      "links",
      "track_videos",
    ];
    for (const table of tables) {
      await sb.schema(JUKEBOX_SCHEMA).from(table).delete().eq("track_id", trackId);
    }
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("tracks").delete().eq("id", trackId);
    if (error) return bad(error.message || "Could not remove song.", 500);
    if (ctx.track.track_number != null) {
      const { data: rest } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("id,track_number")
        .eq("album_id", ctx.track.album_id)
        .gt("track_number", ctx.track.track_number)
        .order("track_number", { ascending: true });
      for (const row of rest || []) {
        await sb
          .schema(JUKEBOX_SCHEMA)
          .from("tracks")
          .update({ track_number: (row.track_number as number) - 1 })
          .eq("id", row.id);
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "add_link") {
    const linkName = String(body.link_name || body.name || "")
      .trim()
      .slice(0, 80);
    const url = String(body.url || "")
      .trim()
      .slice(0, 500);
    if (!linkName || !url) return bad("Name and URL required.");
    if (!/^https?:\/\//i.test(url)) return bad("Link must start with http:// or https://");
    const { data: pri } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("links")
      .select("link_priority")
      .eq("track_id", trackId)
      .order("link_priority", { ascending: false })
      .limit(1);
    const priority = ((pri?.[0]?.link_priority as number) || 0) + 1;
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("links")
      .insert({ track_id: trackId, link_name: linkName, url, link_priority: priority })
      .select("id,link_name,url,link_priority")
      .single();
    if (error) return bad(error.message || "Could not add link.", 500);
    return NextResponse.json({ ok: true, link: data });
  }

  if (action === "delete_link") {
    const linkId = uuid(body.link_id);
    if (!linkId) return bad("link_id required.");
    const { data: link } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("links")
      .select("id,track_id")
      .eq("id", linkId)
      .maybeSingle();
    if (!link || link.track_id !== trackId) return bad("Link not found.", 404);
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("links").delete().eq("id", linkId);
    if (error) return bad(error.message || "Could not remove link.", 500);
    return NextResponse.json({ ok: true });
  }

  if (action === "add_video") {
    const videoId = parseYouTubeVideoId(String(body.youtube_url || body.video_id || ""));
    if (!videoId) return bad("Paste a YouTube link or video id.");
    try {
      await recordTrackVideo(
        sb,
        trackId,
        {
          videoId,
          title: typeof body.title === "string" ? body.title : null,
          channel: typeof body.channel === "string" ? body.channel : null,
          label: typeof body.label === "string" ? body.label : null,
        },
        {
          makePrimary: false,
          source: "manual",
          addedBy: user.email || null,
          addedByName:
            (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name) ||
            user.email ||
            null,
          artistName: ctx.artist.name,
          countsForCharts: false,
        },
      );
      return NextResponse.json({
        ok: true,
        video: {
          video_id: videoId,
          title: typeof body.title === "string" ? body.title : null,
          channel: typeof body.channel === "string" ? body.channel : null,
          thumbnail: thumbFor(videoId),
          is_primary: false,
          is_playable: true,
          label: typeof body.label === "string" ? body.label : null,
          counts_for_charts: false,
        },
      });
    } catch (e) {
      return bad(e instanceof Error ? e.message : "Could not add that video.", 500);
    }
  }

  if (action === "remove_video") {
    const videoId = String(body.video_id || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return bad("video_id required.");
    const { data: rows } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .select("video_id,is_primary")
      .eq("track_id", trackId);
    const list = rows || [];
    if (list.length <= 1) return bad("A track needs at least one video.");
    const target = list.find((r) => r.video_id === videoId);
    if (!target) return bad("Version not found.", 404);
    if (target.is_primary) return bad("Make another version the default before removing this one.");
    const { error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .delete()
      .eq("track_id", trackId)
      .eq("video_id", videoId);
    if (error) return bad(error.message || "Could not remove that version.", 400);
    return NextResponse.json({ ok: true });
  }

  if (action === "set_primary_video" || action === "set_playback_video") {
    const videoId = String(body.video_id || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return bad("video_id required.");
    const { data: hit } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .select("video_id")
      .eq("track_id", trackId)
      .eq("video_id", videoId)
      .maybeSingle();
    if (!hit) return bad("Version not found.", 404);
    await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .update({ is_primary: false })
      .eq("track_id", trackId)
      .neq("video_id", videoId);
    // Playback only — stats/charts are set separately via set_stats_video.
    const { error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .update({ is_primary: true })
      .eq("track_id", trackId)
      .eq("video_id", videoId);
    if (error) return bad(error.message || "Could not set the playback version.", 400);
    // Keep the legacy metrics pointer in step with what plays.
    const { data: met } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("metrics")
      .select("id")
      .eq("track_id", trackId)
      .eq("metric_name", "youtube_video_id")
      .limit(1);
    if (met?.[0]?.id) {
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("metrics")
        .update({ metric_text_value: videoId })
        .eq("id", met[0].id);
    }
    return NextResponse.json({ ok: true, role: "playback" });
  }

  if (action === "set_stats_video") {
    const videoId = String(body.video_id || "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return bad("video_id required.");
    const { data: hit } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .select("video_id")
      .eq("track_id", trackId)
      .eq("video_id", videoId)
      .maybeSingle();
    if (!hit) return bad("Version not found.", 404);
    // Exactly one version should feed the chart: clear the rest first.
    await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .update({ counts_for_charts: false })
      .eq("track_id", trackId)
      .neq("video_id", videoId);
    const { error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_videos")
      .update({ counts_for_charts: true })
      .eq("track_id", trackId)
      .eq("video_id", videoId);
    if (error) return bad(error.message || "Could not set the stats version.", 400);
    return NextResponse.json({ ok: true, role: "stats" });
  }

  return bad("Unknown action.");
}
