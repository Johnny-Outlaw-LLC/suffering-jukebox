import { NextRequest, NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";

export const JUKEBOX_SCHEMA = "jukebox";
export const SJ_PROTECTED_ADMIN_EMAIL = "johnnyoutlawllc@gmail.com";

export const SJ_SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";
export const SJ_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";
function requireServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return key;
}

export function createSjServiceClient() {
  return createClient(SJ_SUPABASE_URL, requireServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createSjAuthClient() {
  return createClient(SJ_SUPABASE_URL, SJ_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function getAuthUser(req: NextRequest): Promise<User | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const authClient = createSjAuthClient();
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function isSjAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const sb = createSjServiceClient();
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("is_app_admin", {
    p_email: email,
  });
  if (error) {
    console.error("[sj-admin] is_app_admin", error.message);
    return email.toLowerCase() === "johnnyoutlawllc@gmail.com";
  }
  return !!data;
}

export async function verifySjAdmin(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 }) };
  }
  const admin = await isSjAdmin(user.email);
  if (!admin) {
    return { error: NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 }) };
  }
  return { ok: true as const, user };
}

export async function upsertSjAppUser(email: string, name?: string | null) {
  const sb = createSjServiceClient();
  await sb.schema(JUKEBOX_SCHEMA).rpc("upsert_app_user", {
    p_email: email,
    p_name: name ?? null,
  });
}

export async function getSjLastUpdated(): Promise<string | null> {
  const sb = createSjServiceClient();
  const { data, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("app_meta")
    .select("value, updated_at")
    .eq("key", "last_updated")
    .maybeSingle();
  if (error || !data) return null;
  // Prefer updated_at (full timestamp) so the UI can show date + time.
  return data.updated_at || data.value || null;
}

export function parseYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      return id && id.length === 11 ? id : null;
    }
    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && v.length === 11) return v;
      const embed = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embed) return embed[1];
    }
  } catch {
    return null;
  }
  return null;
}

export function parseYouTubePlaylistId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // A bare playlist id, pasted directly rather than a full link.
  if (/^(PL|UU|LL|FL|RD|OLAK5uy)[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const list = url.searchParams.get("list");
    return list && list.length >= 10 ? list : null;
  } catch {
    return null;
  }
}

export type YtPlaylistItem = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail: string | null;
};

export type YouTubePlaylistInfo = {
  playlistId: string;
  title: string;
  description: string;
  channelTitle: string;
  thumbnail: string | null;
  itemCount: number | null;
};

// One huge playlist should not blow the request budget or the quota, so
// fetching stops here and the caller is told the list was cut short.
export const MAX_PLAYLIST_ITEMS = 300;

export async function fetchYouTubePlaylistItems(
  playlistId: string,
): Promise<{ items: YtPlaylistItem[]; truncated: boolean }> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const items: YtPlaylistItem[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("key", key);
    const res = await fetch(url.toString());
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("That playlist could not be found — check it is public or unlisted.");
      }
      throw new Error(`YouTube API error (${res.status})`);
    }
    const json = (await res.json()) as { items?: any[]; nextPageToken?: string };
    for (const item of json.items ?? []) {
      const sn = item.snippet ?? {};
      const videoId = sn.resourceId?.videoId as string | undefined;
      if (!videoId) continue;
      // Deleted/private entries carry a placeholder title and nothing playable.
      if (/^(deleted|private) video$/i.test(sn.title || "")) continue;
      const thumbs = sn.thumbnails;
      items.push({
        videoId,
        title: sn.title || "Untitled",
        channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle || "",
        thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
      });
      if (items.length >= MAX_PLAYLIST_ITEMS) { truncated = true; break; }
    }
    pageToken = truncated ? undefined : json.nextPageToken;
  } while (pageToken);
  return { items, truncated };
}

export async function fetchYouTubePlaylistInfo(playlistId: string): Promise<YouTubePlaylistInfo | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
  url.searchParams.set("part", "snippet,contentDetails,status");
  url.searchParams.set("id", playlistId);
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube API error (${res.status})`);
  const json = (await res.json()) as { items?: any[] };
  const item = json.items?.[0];
  if (!item || item.status?.privacyStatus === "private") return null;
  const snippet = item.snippet ?? {};
  const thumbs = snippet.thumbnails;
  return {
    playlistId: item.id,
    title: snippet.title || "Untitled playlist",
    description: snippet.description || "",
    channelTitle: snippet.channelTitle || "",
    thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
    itemCount: Number.isFinite(Number(item.contentDetails?.itemCount))
      ? Number(item.contentDetails.itemCount)
      : null,
  };
}

export async function searchYouTubePlaylists(
  query: string,
  maxResults = 10,
): Promise<YouTubePlaylistInfo[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("type", "playlist");
  url.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 15)));
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube playlist search error (${res.status})`);
  const json = (await res.json()) as { items?: any[] };
  const candidates = (json.items ?? [])
    .map((item) => ({ playlistId: item.id?.playlistId as string | undefined, snippet: item.snippet ?? {} }))
    .filter((item): item is { playlistId: string; snippet: any } => !!item.playlistId);
  if (!candidates.length) return [];

  // search.list does not include a playlist's item count. One batched
  // playlists.list call fills it in without making the client fetch every
  // candidate playlist just to show useful search results.
  const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/playlists");
  detailsUrl.searchParams.set("part", "contentDetails,status");
  detailsUrl.searchParams.set("id", candidates.map((item) => item.playlistId).join(","));
  detailsUrl.searchParams.set("maxResults", String(candidates.length));
  detailsUrl.searchParams.set("key", key);
  const detailsRes = await fetch(detailsUrl.toString());
  if (!detailsRes.ok) throw new Error(`YouTube playlist details error (${detailsRes.status})`);
  const detailsJson = (await detailsRes.json()) as { items?: any[] };
  const details = new Map((detailsJson.items ?? []).map((item) => [item.id as string, item]));

  return candidates.flatMap(({ playlistId, snippet }) => {
    const detail = details.get(playlistId);
    if (!detail || detail.status?.privacyStatus === "private") return [];
    const thumbs = snippet.thumbnails;
    return [{
      playlistId,
      title: snippet.title || "Untitled playlist",
      description: snippet.description || "",
      channelTitle: snippet.channelTitle || "",
      thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
      itemCount: Number.isFinite(Number(detail.contentDetails?.itemCount))
        ? Number(detail.contentDetails.itemCount)
        : null,
    }];
  });
}

export type YtVideoInfo = {
  id: string;
  /** True only if the video will actually play inside our embedded player. */
  playable: boolean;
  reason: string | null;
  ageRestricted: boolean;
  views: number;
  likes: number;
  thumbnail: string | null;
  title: string;
  channelTitle: string;
  /** From snippet.publishedAt (ISO-8601). Original upload date on YouTube. */
  publishedAt: string | null;
  /** From contentDetails.duration (ISO-8601). Used for LRCLIB exact match. */
  durationMs: number | null;
};

/** PT3M26S → milliseconds. YouTube's contentDetails.duration shape. */
export function parseYouTubeDuration(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  const ms = ((Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0)) * 1000;
  return ms > 0 ? ms : null;
}

// Batch-fetch full playability + stats for up to any number of video ids.
// A video id that is absent from the result was deleted/removed by YouTube.
export async function fetchYouTubeVideoInfo(
  videoIds: string[],
): Promise<Record<string, YtVideoInfo>> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const out: Record<string, YtVideoInfo> = {};
  const ids = [...new Set(videoIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "status,contentDetails,statistics,snippet");
    url.searchParams.set("id", chunk.join(","));
    url.searchParams.set("key", key);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`YouTube API error (${res.status})`);
    const json = (await res.json()) as { items?: any[] };
    for (const item of json.items ?? []) {
      const status = item.status ?? {};
      const rr = item.contentDetails?.regionRestriction ?? {};
      // YouTube reports age-restricted videos as embeddable:true, but the IFrame
      // player refuses to play them (error 150 — "only available on YouTube"),
      // so they have to be treated as broken for our purposes.
      const ageRestricted = item.contentDetails?.contentRating?.ytRating === "ytAgeRestricted";
      let playable = true;
      let reason: string | null = null;
      if (status.privacyStatus && status.privacyStatus !== "public") {
        playable = false;
        reason = `video is ${status.privacyStatus}`;
      } else if (status.uploadStatus && status.uploadStatus !== "processed") {
        playable = false;
        reason = `upload status ${status.uploadStatus}`;
      } else if (status.embeddable === false) {
        playable = false;
        reason = "embedding disabled by the owner";
      } else if (ageRestricted) {
        playable = false;
        reason = "age-restricted, so it will not play outside YouTube";
      } else if (Array.isArray(rr.blocked) && rr.blocked.includes("US")) {
        playable = false;
        reason = "blocked in the US";
      } else if (Array.isArray(rr.allowed) && !rr.allowed.includes("US")) {
        playable = false;
        reason = "not available in the US";
      }
      const thumbs = item.snippet?.thumbnails;
      out[item.id] = {
        id: item.id,
        playable,
        reason,
        ageRestricted,
        views: Number(item.statistics?.viewCount ?? 0),
        likes: Number(item.statistics?.likeCount ?? 0),
        thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
        title: item.snippet?.title ?? "",
        channelTitle: item.snippet?.channelTitle ?? "",
        publishedAt: item.snippet?.publishedAt ?? null,
        durationMs: parseYouTubeDuration(item.contentDetails?.duration),
      };
    }
  }
  return out;
}

// Search YouTube for embeddable candidate video ids for a track. Most callers
// want relevance, but the alternative-version picker deliberately asks for the
// most-viewed uploads so a user can quickly compare the meaningful choices.
export async function searchYouTubeVideoIds(
  query: string,
  maxResults = 10,
  order: "relevance" | "viewCount" = "relevance",
): Promise<string[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("order", order);
  url.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 15)));
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube search error (${res.status})`);
  const json = (await res.json()) as { items?: any[] };
  return (json.items ?? []).map((it) => it.id?.videoId).filter(Boolean);
}

export type YouTubeSearchResult = {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  thumbnail: string | null;
  durationMs: number | null;
  views: number | null;
  publishedAt: string | null;
};

/**
 * Search candidates for a user's personal library.  We verify each candidate
 * with videos.list before returning it so an unembeddable or removed result
 * cannot be added from the picker.
 */
export async function searchYouTubeVideos(query: string, maxResults = 12): Promise<YouTubeSearchResult[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("type", "video");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 15)));
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube search error (${res.status})`);
  const json = (await res.json()) as { items?: any[] };
  const candidates = (json.items ?? [])
    .map((item) => ({ videoId: item.id?.videoId as string | undefined, snippet: item.snippet ?? {} }))
    .filter((item): item is { videoId: string; snippet: any } => !!item.videoId);
  const details = await fetchYouTubeVideoInfo(candidates.map((item) => item.videoId));
  return candidates
    .filter((item) => details[item.videoId]?.playable)
    .map((item) => {
      const detail = details[item.videoId];
      const thumbs = item.snippet?.thumbnails;
      return {
        videoId: item.videoId,
        title: detail?.title || item.snippet?.title || "Untitled video",
        description: item.snippet?.description || "",
        channelTitle: detail?.channelTitle || item.snippet?.channelTitle || "",
        thumbnail: detail?.thumbnail ?? thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
        durationMs: detail?.durationMs ?? null,
        views: detail?.views ?? null,
        publishedAt: detail?.publishedAt ?? null,
      };
    });
}

export async function fetchYouTubeVideoStats(videoId: string) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "statistics,snippet");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube API error (${res.status})`);
  const json = (await res.json()) as {
    items?: Array<{
      statistics?: { viewCount?: string; likeCount?: string };
      snippet?: { thumbnails?: { medium?: { url?: string }; default?: { url?: string } } };
    }>;
  };
  const item = json.items?.[0];
  if (!item) throw new Error("Video not found on YouTube.");
  const thumbs = item.snippet?.thumbnails;
  return {
    views: Number(item.statistics?.viewCount ?? 0),
    likes: Number(item.statistics?.likeCount ?? 0),
    thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
  };
}
