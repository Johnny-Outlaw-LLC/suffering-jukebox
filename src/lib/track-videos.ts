// jukebox.track_videos - every YouTube upload we have ever known for a track.
//
// A track used to carry exactly one youtube_video_id metric, so when the nightly
// auto-resolve swapped in a replacement the previous upload disappeared and the
// chart bar collapsed with it. Every path that changes a track's video now
// records the video here instead of overwriting history, and the charts read the
// most-viewed row rather than whichever one happens to be current.

import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

type Sb = ReturnType<typeof createSjServiceClient>;

export type TrackVideoInput = {
  videoId: string;
  title?: string | null;
  channel?: string | null;
  thumbnail?: string | null;
  views?: number | null;
  likes?: number | null;
  playable?: boolean;
};

// Label a version the way a listener would describe it, so the switcher in the
// player reads "Music Video" rather than a channel name.
export function labelForVideo(title?: string | null, channel?: string | null): string | null {
  const t = (title || "").toLowerCase();
  const c = (channel || "").toLowerCase();
  if (/official music video|\(official video\)|music video/.test(t)) return "Music Video";
  if (/\blive\b|\bsession\b|\bkexp\b/.test(t)) return "Live";
  if (/\blyrics?\b/.test(t)) return "Lyric Video";
  if (/- topic$/.test(c)) return "Original Audio";
  return null;
}

export function thumbFor(videoId: string, thumbnail?: string | null): string {
  return thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

// Record a video against a track without losing what was there before.
// `makePrimary` promotes it to the default that plays and supplies the artwork.
export async function recordTrackVideo(
  sb: Sb,
  trackId: string,
  v: TrackVideoInput,
  opts: { makePrimary?: boolean; source?: string; addedBy?: string | null; addedByName?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    track_id: trackId,
    video_id: v.videoId,
    title: v.title ?? null,
    channel: v.channel ?? null,
    thumbnail: thumbFor(v.videoId, v.thumbnail),
    label: labelForVideo(v.title, v.channel),
    source: opts.source ?? "sync",
    updated_at: now,
  };
  // Never overwrite a known count with a null - a failed stats lookup should
  // leave yesterday's number standing rather than blank the chart.
  if (typeof v.views === "number") { row.view_count = v.views; row.stats_at = now; }
  if (typeof v.likes === "number") row.like_count = v.likes;
  if (typeof v.playable === "boolean") {
    row.is_playable = v.playable;
    row.unavailable_at = v.playable ? null : now;
  }
  if (opts.addedBy)     row.added_by = opts.addedBy;
  if (opts.addedByName) row.added_by_name = opts.addedByName;

  const { error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_videos")
    .upsert(row, { onConflict: "track_id,video_id" });
  if (error) {
    console.error("[track-videos:upsert]", error);
    return;
  }

  if (opts.makePrimary) {
    // Two statements rather than one: clear the old default first so a track can
    // never end up with two primaries if the second call fails.
    await sb.schema(JUKEBOX_SCHEMA).from("track_videos")
      .update({ is_primary: false }).eq("track_id", trackId).neq("video_id", v.videoId);
    await sb.schema(JUKEBOX_SCHEMA).from("track_videos")
      .update({ is_primary: true }).eq("track_id", trackId).eq("video_id", v.videoId);
  }
}
