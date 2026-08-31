// Artist Deep Dive research helpers — pure shaping + source lookups.
// Writes go through /api/research with the service role.

import {
  fetchYouTubeVideoInfo,
  searchYouTubeVideos,
  type YouTubeSearchResult,
} from "@/lib/sj-admin-auth";

export const RESEARCH_MEDIA_TYPES = [
  "youtube_video",
  "audio_podcast",
  "article",
  "interview",
  "documentary",
  "other",
] as const;

export type ResearchMediaType = (typeof RESEARCH_MEDIA_TYPES)[number];

export const RESEARCH_MEDIA_LABELS: Record<ResearchMediaType, string> = {
  youtube_video: "YouTube Video",
  audio_podcast: "Audio Only Podcast",
  article: "Article",
  interview: "Interview",
  documentary: "Documentary",
  other: "Other",
};

export type ResearchItem = {
  id: string;
  artistId: string;
  isSupplemental: boolean;
  mediaType: ResearchMediaType;
  mediaTypeLabel: string;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  sourceName: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  channelId: string | null;
  externalId: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
  audioUrl: string | null;
  storagePath: string | null;
  durationMs: number | null;
  viewCount: number | null;
  publishedAt: string | null;
  addedAt: string;
  transcript: string | null;
  transcriptSource: string | null;
  addedBy: string | null;
  addedByName: string | null;
  addedVia: string;
  visibility: "public" | "private";
  metadata: Record<string, unknown>;
};

export type ResearchCandidate = {
  key: string;
  mediaType: ResearchMediaType;
  title: string;
  description: string | null;
  sourceUrl: string;
  sourceName: string;
  creatorName: string | null;
  creatorUrl: string | null;
  channelId: string | null;
  externalId: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
  durationMs: number | null;
  viewCount: number | null;
  publishedAt: string | null;
  alreadyAdded: boolean;
};

const YT_ID_RE =
  /(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

export function parseYouTubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(YT_ID_RE);
  return m?.[1] ?? null;
}

export function isResearchMediaType(v: unknown): v is ResearchMediaType {
  return typeof v === "string" && (RESEARCH_MEDIA_TYPES as readonly string[]).includes(v);
}

export function shapeResearchItem(row: any): ResearchItem {
  const mediaType = (isResearchMediaType(row.media_type) ? row.media_type : "other") as ResearchMediaType;
  return {
    id: row.id,
    artistId: row.artist_id,
    isSupplemental: row.is_supplemental !== false,
    mediaType,
    mediaTypeLabel: RESEARCH_MEDIA_LABELS[mediaType],
    title: row.title || "Untitled",
    description: row.description ?? null,
    sourceUrl: row.source_url ?? null,
    sourceName: row.source_name ?? null,
    creatorName: row.creator_name ?? null,
    creatorUrl: row.creator_url ?? null,
    channelId: row.channel_id ?? null,
    externalId: row.external_id ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    embedUrl: row.embed_url ?? null,
    audioUrl: row.audio_url ?? null,
    storagePath: row.storage_path ?? null,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    viewCount: row.view_count == null ? null : Number(row.view_count),
    publishedAt: row.published_at ?? null,
    addedAt: row.added_at,
    transcript: row.transcript ?? null,
    transcriptSource: row.transcript_source ?? null,
    addedBy: row.added_by ?? null,
    addedByName: row.added_by_name ?? null,
    addedVia: row.added_via || "manual",
    visibility: row.visibility === "private" ? "private" : "public",
    metadata: (row.metadata && typeof row.metadata === "object") ? row.metadata : {},
  };
}

export const RESEARCH_ITEM_SELECT =
  "id,artist_id,is_supplemental,media_type,title,description,source_url,source_name,creator_name,creator_url,channel_id,external_id,thumbnail_url,embed_url,audio_url,storage_path,duration_ms,view_count,published_at,added_at,transcript,transcript_source,added_by,added_by_name,added_via,visibility,metadata";

function guessMediaTypeFromTitle(title: string, fallback: ResearchMediaType = "youtube_video"): ResearchMediaType {
  const t = title.toLowerCase();
  if (/\b(documentary|doc series|full film)\b/.test(t)) return "documentary";
  if (/\b(interview|q&a|q & a|talks with|in conversation)\b/.test(t)) return "interview";
  if (/\b(podcast|episode|ep\.|full episode)\b/.test(t)) return "audio_podcast";
  return fallback;
}

function ytCandidate(v: YouTubeSearchResult, mediaType?: ResearchMediaType): ResearchCandidate {
  const type = mediaType || guessMediaTypeFromTitle(v.title);
  return {
    key: `yt:${v.videoId}`,
    mediaType: type,
    title: v.title,
    description: v.description || null,
    sourceUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
    sourceName: "YouTube",
    creatorName: v.channelTitle || null,
    creatorUrl: null,
    channelId: null,
    externalId: v.videoId,
    thumbnailUrl: v.thumbnail,
    embedUrl: `https://www.youtube.com/embed/${v.videoId}`,
    durationMs: v.durationMs,
    viewCount: v.views,
    publishedAt: v.publishedAt,
    alreadyAdded: false,
  };
}

/** Free, no-paywall Wikipedia page about the artist when one exists. */
export async function searchWikipediaArticle(artistName: string): Promise<ResearchCandidate | null> {
  const q = artistName.trim();
  if (q.length < 2) return null;
  try {
    const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("list", "search");
    searchUrl.searchParams.set("srsearch", q);
    searchUrl.searchParams.set("srlimit", "5");
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("origin", "*");
    const searchRes = await fetch(searchUrl.toString(), {
      headers: { "User-Agent": "SufferingJukebox/1.0 (research; contact@sufferingjukebox.stream)" },
      cache: "no-store",
    });
    if (!searchRes.ok) return null;
    const searchJson = (await searchRes.json()) as {
      query?: { search?: Array<{ title: string; pageid: number; snippet: string }> };
    };
    const hits = searchJson.query?.search ?? [];
    if (!hits.length) return null;

    const pick =
      hits.find((h) => h.title.toLowerCase() === q.toLowerCase()) ||
      hits.find((h) => h.title.toLowerCase().startsWith(q.toLowerCase())) ||
      hits[0];

    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pick.title)}`;
    const sumRes = await fetch(summaryUrl, {
      headers: { "User-Agent": "SufferingJukebox/1.0 (research; contact@sufferingjukebox.stream)" },
      cache: "no-store",
    });
    if (!sumRes.ok) return null;
    const sum = (await sumRes.json()) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
      thumbnail?: { source?: string };
      timestamp?: string;
      type?: string;
    };
    if (sum.type === "disambiguation") return null;
    const pageUrl = sum.content_urls?.desktop?.page;
    if (!pageUrl) return null;
    return {
      key: `wiki:${pick.pageid}`,
      mediaType: "article",
      title: sum.title || pick.title,
      description: sum.extract || pick.snippet?.replace(/<[^>]+>/g, "") || null,
      sourceUrl: pageUrl,
      sourceName: "Wikipedia",
      creatorName: "Wikipedia contributors",
      creatorUrl: pageUrl,
      channelId: null,
      externalId: `wiki:${pick.pageid}`,
      thumbnailUrl: sum.thumbnail?.source ?? null,
      embedUrl: null,
      durationMs: null,
      viewCount: null,
      publishedAt: sum.timestamp ?? null,
      alreadyAdded: false,
    };
  } catch (e) {
    console.warn("[research] wikipedia", e);
    return null;
  }
}

/**
 * Run a multi-query YouTube sweep + Wikipedia for an artist.
 * Caps results to keep inside YouTube quota and the Vercel time budget.
 */
export async function runArtistResearch(artistName: string): Promise<ResearchCandidate[]> {
  const name = artistName.trim();
  if (name.length < 2) return [];

  const queries: Array<{ q: string; type?: ResearchMediaType }> = [
    { q: `${name} interview`, type: "interview" },
    { q: `${name} podcast`, type: "audio_podcast" },
    { q: `${name} documentary`, type: "documentary" },
    { q: `${name} live session conversation`, type: "interview" },
  ];

  const seen = new Set<string>();
  const out: ResearchCandidate[] = [];

  for (const { q, type } of queries) {
    try {
      const hits = await searchYouTubeVideos(q, 6);
      for (const hit of hits) {
        if (seen.has(hit.videoId)) continue;
        seen.add(hit.videoId);
        out.push(ytCandidate(hit, type));
      }
    } catch (e) {
      console.warn("[research] youtube query", q, e);
    }
  }

  const wiki = await searchWikipediaArticle(name);
  if (wiki) out.push(wiki);

  return out;
}

/** Pull public YouTube captions when available (manual or auto). */
export async function fetchYouTubeTranscript(videoId: string): Promise<{
  text: string;
  source: string;
} | null> {
  const id = parseYouTubeId(videoId);
  if (!id) return null;
  try {
    const watchRes = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SufferingJukebox/1.0; +https://sufferingjukebox.stream)",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });
    if (!watchRes.ok) return null;
    const html = await watchRes.text();
    // Avoid /s flag (project target is ES2017). Find the assignment, then brace-match.
    const marker = "ytInitialPlayerResponse";
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const eq = html.indexOf("=", at + marker.length);
    if (eq < 0) return null;
    const start = html.indexOf("{", eq);
    if (start < 0) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < html.length && i < start + 2_000_000; i++) {
      const ch = html[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) return null;
    let player: any;
    try {
      player = JSON.parse(html.slice(start, end + 1));
    } catch {
      return null;
    }
    const tracks: any[] =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) return null;
    const prefer =
      tracks.find((t) => t.languageCode === "en" && !t.kind) ||
      tracks.find((t) => String(t.languageCode || "").startsWith("en")) ||
      tracks[0];
    if (!prefer?.baseUrl) return null;
    const capRes = await fetch(prefer.baseUrl + "&fmt=json3", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SufferingJukebox/1.0; +https://sufferingjukebox.stream)",
      },
      cache: "no-store",
    });
    if (!capRes.ok) return null;
    const cap = (await capRes.json()) as {
      events?: Array<{ segs?: Array<{ utf8?: string }> }>;
    };
    const lines = (cap.events ?? [])
      .map((ev) => (ev.segs ?? []).map((s) => s.utf8 || "").join(""))
      .map((l) => l.replace(/\n/g, " ").trim())
      .filter(Boolean);
    const text = lines.join("\n").trim();
    if (!text) return null;
    const source = prefer.kind === "asr" ? "youtube_auto" : "youtube_manual";
    return { text, source };
  } catch (e) {
    console.warn("[research] transcript", id, e);
    return null;
  }
}

export async function enrichYouTubeCandidate(videoIdOrUrl: string): Promise<ResearchCandidate | null> {
  const id = parseYouTubeId(videoIdOrUrl);
  if (!id) return null;
  const info = await fetchYouTubeVideoInfo([id]);
  const detail = info[id];
  if (!detail?.playable) return null;
  return ytCandidate({
    videoId: id,
    title: detail.title,
    description: "",
    channelTitle: detail.channelTitle,
    thumbnail: detail.thumbnail,
    durationMs: detail.durationMs,
    views: detail.views,
    publishedAt: detail.publishedAt,
  });
}

/** Heuristic: treat known open publishers as free; skip obvious paywalls. */
export function looksPaywalled(url: string, hostname?: string): boolean {
  const host = (hostname || (() => {
    try { return new URL(url).hostname; } catch { return ""; }
  })()).toLowerCase();
  const blocked = [
    "nytimes.com", "wsj.com", "ft.com", "bloomberg.com", "economist.com",
    "newyorker.com", "washingtonpost.com", "theathletic.com", "barrons.com",
    "businessinsider.com", "wired.com", "vanityfair.com",
  ];
  return blocked.some((d) => host === d || host.endsWith("." + d));
}

export function guessMediaTypeFromUrl(url: string): ResearchMediaType {
  if (parseYouTubeId(url)) return "youtube_video";
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("wikipedia.org")) return "article";
    if (host.includes("podcast") || host.includes("soundcloud") || host.includes("anchor.fm")) {
      return "audio_podcast";
    }
    if (/\.(mp3|m4a|ogg|opus|wav)(\?|$)/i.test(url)) return "audio_podcast";
  } catch { /* ignore */ }
  return "article";
}
