import { NextRequest, NextResponse } from "next/server";
import { ownerMyJukebox } from "@/lib/my-jukebox";
import {
  fetchYouTubePlaylistItems,
  fetchYouTubeVideoInfo,
  JUKEBOX_SCHEMA,
  parseYouTubePlaylistId,
  searchYouTubeVideos,
} from "@/lib/sj-admin-auth";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";
// A big playlist walks several YouTube API pages in sequence; the default
// 10s Vercel budget is not enough room for that.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const ctx = await ownerMyJukebox(req);
    if (!ctx) return bad("Sign in to search YouTube for My Jukebox.", 401);
    if (rateLimited(`my-jukebox-search:${clientIp(req)}`, 20)) return tooMany();
    const url = new URL(req.url);

    const playlistParam = url.searchParams.get("playlist")?.trim();
    if (playlistParam) {
      const playlistId = parseYouTubePlaylistId(playlistParam);
      if (!playlistId) return bad("That doesn't look like a YouTube playlist link.");
      const { items, truncated } = await fetchYouTubePlaylistItems(playlistId);
      if (!items.length) return NextResponse.json({ ok: true, results: [], truncated: false });

      // A playlist can list the same video twice; keep the first occurrence.
      const seen = new Set<string>();
      const deduped = items.filter((it) => (seen.has(it.videoId) ? false : (seen.add(it.videoId), true)));

      const info = await fetchYouTubeVideoInfo(deduped.map((it) => it.videoId));
      const { data: known } = await ctx.sb
        .schema(JUKEBOX_SCHEMA)
        .from("track_videos")
        .select("video_id,track_id")
        .in("video_id", deduped.map((it) => it.videoId));
      const knownMap = new Map((known ?? []).map((r: any) => [r.video_id as string, r.track_id as string]));

      const results = deduped
        .filter((it) => info[it.videoId]?.playable)
        .map((it) => ({
          videoId: it.videoId,
          title: info[it.videoId]?.title || it.title,
          description: "",
          channelTitle: info[it.videoId]?.channelTitle || it.channelTitle,
          thumbnail: info[it.videoId]?.thumbnail ?? it.thumbnail,
          durationMs: info[it.videoId]?.durationMs ?? null,
          views: info[it.videoId]?.views ?? null,
          // Present when this exact upload is already a catalogue track — the
          // playlist builder adds it directly rather than importing it again.
          existingTrackId: knownMap.get(it.videoId) ?? null,
        }));
      return NextResponse.json({ ok: true, results, truncated });
    }

    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length < 2) return NextResponse.json({ ok: true, results: [] });
    return NextResponse.json({ ok: true, results: await searchYouTubeVideos(query) });
  } catch (error) {
    console.error("[my-jukebox:search]", error);
    return bad((error as Error)?.message || "Could not search YouTube right now.", 502);
  }
}
