// Refresh view/like counts for every video in jukebox.track_videos.
//
// The nightly YouTube snapshot only ever knew about the one video a track was
// pointing at. Alternate versions need their own numbers, otherwise the chart
// bar (which reads the most-viewed version) would be frozen at whatever we
// happened to record the day the version was added.
//
// Costs 1 quota unit per 50 ids, so a full pass over ~3,100 videos is ~63 units.

import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, isSjAdmin, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = { id: string; video_id: string };

type YtItem = {
  id?: string;
  status?: { embeddable?: boolean; privacyStatus?: string };
  statistics?: { viewCount?: string; likeCount?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
  };
};

async function fetchBatch(ids: string[]): Promise<Record<string, YtItem>> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "statistics,snippet,status");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube API error (${res.status})`);
  const json = (await res.json()) as { items?: YtItem[] };
  const out: Record<string, YtItem> = {};
  for (const it of json.items ?? []) if (it.id) out[it.id] = it;
  return out;
}

async function authorize(req: NextRequest) {
  const cronSecret = process.env.SJ_CRON_SECRET?.trim();
  const header = req.headers.get("authorization")?.trim();
  if (cronSecret && header === `Bearer ${cronSecret}`) return true;
  const user = await getAuthUser(req);
  return !!user?.email && (await isSjAdmin(user.email));
}

export async function POST(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  // Default to the alternates only: the primary of each track already gets fresh
  // numbers from the nightly snapshot job. Pass all=true for a full sweep.
  const all = body?.all === true;
  const limit = Math.min(Number(body?.limit) || 1500, 4000);

  const sb = createSjServiceClient();
  let q = sb.schema(JUKEBOX_SCHEMA).from("track_videos").select("id, video_id");
  if (!all) q = q.eq("is_primary", false);
  const { data, error } = await q.order("stats_at", { ascending: true, nullsFirst: true }).limit(limit);
  if (error) {
    console.error("[sj-video-stats:read]", error);
    return NextResponse.json({ ok: false, error: "Could not read videos." }, { status: 500 });
  }

  const rows = (data ?? []) as Row[];
  const now = new Date().toISOString();
  let updated = 0;
  let goneCount = 0;

  for (let i = 0; i < rows.length; i += 50) {
    const slice = rows.slice(i, i + 50);
    let info: Record<string, YtItem>;
    try {
      info = await fetchBatch(slice.map((r) => r.video_id));
    } catch (err) {
      console.error("[sj-video-stats:youtube]", err);
      // Quota or a transient error - stop rather than mark the rest as gone.
      break;
    }

    for (const row of slice) {
      const it = info[row.video_id];
      if (!it) {
        // Absent from the response means deleted or private. Keep the row and
        // its history, but take it out of the running for the chart.
        await sb.schema(JUKEBOX_SCHEMA).from("track_videos")
          .update({ is_playable: false, unavailable_at: now, stats_at: now })
          .eq("id", row.id);
        goneCount++;
        continue;
      }
      const thumbs = it.snippet?.thumbnails;
      const embeddable = it.status?.embeddable !== false;
      await sb.schema(JUKEBOX_SCHEMA).from("track_videos").update({
        view_count: Number(it.statistics?.viewCount ?? 0),
        like_count: Number(it.statistics?.likeCount ?? 0),
        title: it.snippet?.title ?? null,
        channel: it.snippet?.channelTitle ?? null,
        thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? `https://i.ytimg.com/vi/${row.video_id}/mqdefault.jpg`,
        is_playable: embeddable,
        unavailable_at: embeddable ? null : now,
        stats_at: now,
      }).eq("id", row.id);
      updated++;
    }
  }

  return NextResponse.json({ ok: true, checked: rows.length, updated, unavailable: goneCount });
}
