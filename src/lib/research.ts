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
  "interview",
  "documentary",
  "other",
] as const;

export type ResearchMediaType = (typeof RESEARCH_MEDIA_TYPES)[number];

export const RESEARCH_MEDIA_LABELS: Record<ResearchMediaType, string> = {
  youtube_video: "YouTube Video",
  audio_podcast: "Audio Only Podcast",
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
  const rawType = row.media_type;
  const mediaType = (
    isResearchMediaType(rawType)
      ? rawType
      : rawType === "article"
        ? "other"
        : "other"
  ) as ResearchMediaType;
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

// List/dropdown reads skip transcript — podcast captions can be megabytes and
// were the main reason Silver Jews supplemental content took a minute to appear.
export const RESEARCH_ITEM_LIST_SELECT =
  "id,artist_id,is_supplemental,media_type,title,description,source_url,source_name,creator_name,creator_url,channel_id,external_id,thumbnail_url,embed_url,audio_url,storage_path,duration_ms,view_count,published_at,added_at,transcript_source,added_by,added_by_name,added_via,visibility,metadata";

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

/**
 * Run a multi-query YouTube sweep for an artist.
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

  return out;
}

const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}&prettyPrint=false`;
const INNERTUBE_PLAYER_URL_NO_KEY = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_IOS_CLIENT = {
  clientName: "IOS",
  clientVersion: "20.10.38",
  clientId: "5",
  userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)",
} as const;
const INNERTUBE_ANDROID_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  clientId: "3",
  userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
} as const;
const BROWSER_CAPTION_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20240410.00.00",
  clientId: "1",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
} as const;

type InnertubeClient = typeof INNERTUBE_IOS_CLIENT | typeof INNERTUBE_ANDROID_CLIENT;
type CaptionFetchClient = InnertubeClient | typeof BROWSER_CAPTION_CLIENT;

type CaptionTrack = {
  languageCode?: string;
  kind?: string;
  baseUrl?: string;
};

function pickCaptionTrack(tracks: CaptionTrack[], lang?: string): CaptionTrack | null {
  if (!tracks.length) return null;
  const code = (t: CaptionTrack) => (t.languageCode || "").toLowerCase();
  const isEn = (t: CaptionTrack) => code(t) === "en" || code(t).startsWith("en-");
  if (lang) {
    const exact = tracks.find((t) => t.languageCode === lang);
    if (exact) return exact;
    const prefix = tracks.find((t) => code(t).startsWith(lang.toLowerCase()));
    if (prefix) return prefix;
  }
  return (
    tracks.find((t) => isEn(t) && t.kind !== "asr") ||
    tracks.find((t) => isEn(t)) ||
    tracks[0]
  );
}

function innertubeHeaders(client: CaptionFetchClient): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": client.userAgent,
    "X-Youtube-Client-Name": client.clientId,
    "X-Youtube-Client-Version": client.clientVersion,
  };
}

function parseInlinePlayerJson(html: string, globalName: string): Record<string, unknown> | null {
  const startToken = `var ${globalName} = `;
  const startIndex = html.indexOf(startToken);
  if (startIndex === -1) return null;
  const jsonStart = startIndex + startToken.length;
  let depth = 0;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(jsonStart, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchCaptionTracksFromWatchPage(videoId: string): Promise<CaptionTrack[]> {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": BROWSER_CAPTION_CLIENT.userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const player = parseInlinePlayerJson(html, "ytInitialPlayerResponse");
    const status = (player?.playabilityStatus as { status?: string } | undefined)?.status;
    if (status !== "OK") return [];
    const tracks = (player?.captions as {
      playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
    } | undefined)?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

async function fetchCaptionTracksForClient(
  videoId: string,
  client: InnertubeClient,
  playerUrl: string,
  body: Record<string, unknown>,
): Promise<CaptionTrack[]> {
  try {
    const resp = await fetch(playerUrl, {
      method: "POST",
      headers: innertubeHeaders(client),
      body: JSON.stringify(body),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (data?.playabilityStatus?.status !== "OK") return [];
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

async function fetchCaptionTracks(videoId: string): Promise<Array<{ track: CaptionTrack; client: CaptionFetchClient }>> {
  const out: Array<{ track: CaptionTrack; client: CaptionFetchClient }> = [];
  const iosTracks = await fetchCaptionTracksForClient(
    videoId,
    INNERTUBE_IOS_CLIENT,
    INNERTUBE_PLAYER_URL,
    {
      context: {
        client: {
          clientName: INNERTUBE_IOS_CLIENT.clientName,
          clientVersion: INNERTUBE_IOS_CLIENT.clientVersion,
          hl: "en",
          gl: "US",
          deviceMake: "Apple",
          deviceModel: "iPhone16,2",
          osName: "iPhone",
          osVersion: "17_4.0",
          clientFormFactor: "SMALL_FORM_FACTOR",
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    },
  );
  iosTracks.forEach((track) => out.push({ track, client: INNERTUBE_IOS_CLIENT }));

  const androidTracks = await fetchCaptionTracksForClient(
    videoId,
    INNERTUBE_ANDROID_CLIENT,
    INNERTUBE_PLAYER_URL_NO_KEY,
    {
      context: {
        client: {
          clientName: INNERTUBE_ANDROID_CLIENT.clientName,
          clientVersion: INNERTUBE_ANDROID_CLIENT.clientVersion,
        },
      },
      videoId,
    },
  );
  androidTracks.forEach((track) => out.push({ track, client: INNERTUBE_ANDROID_CLIENT }));
  if (!out.length) {
    const pageTracks = await fetchCaptionTracksFromWatchPage(videoId);
    pageTracks.forEach((track) => out.push({ track, client: BROWSER_CAPTION_CLIENT }));
  }
  return out;
}

function transcriptSourceForTrack(track: CaptionTrack): string {
  return track.kind === "asr" ? "youtube_auto" : "youtube_manual";
}

function parseJson3Transcript(raw: string): string[] {
  try {
    const data = JSON.parse(raw) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
    const lines: string[] = [];
    for (const ev of data.events || []) {
      if (!Array.isArray(ev.segs)) continue;
      const text = ev.segs
        .map((seg) => String(seg?.utf8 || ""))
        .join("")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(text);
    }
    return lines;
  } catch {
    return [];
  }
}

function parseXmlTranscript(xml: string): string[] {
  const lines: string[] = [];
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = pRegex.exec(xml)) !== null) {
    const inner = match[3];
    let text = "";
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRegex.exec(inner)) !== null) text += sMatch[1];
    if (!text) text = inner.replace(/<[^>]+>/g, "");
    text = text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.push(text);
  }
  if (lines.length) return lines;
  const classic = [...xml.matchAll(/<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g)];
  return classic
    .map((result) =>
      String(result[3] || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

async function fetchCaptionLines(baseUrl: string, client: CaptionFetchClient): Promise<string[]> {
  const attempts = [
    `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=json3`,
    baseUrl,
  ];
  const headers: Record<string, string> = { "User-Agent": client.userAgent };
  if (client !== BROWSER_CAPTION_CLIENT) {
    headers["X-Youtube-Client-Name"] = client.clientId;
    headers["X-Youtube-Client-Version"] = client.clientVersion;
  }
  for (const url of attempts) {
    try {
      const captionUrl = new URL(url);
      if (!captionUrl.hostname.endsWith(".youtube.com")) continue;
    } catch {
      continue;
    }
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) continue;
      const body = await resp.text();
      if (!body.trim()) continue;
      const lines = body.trimStart().startsWith("{")
        ? parseJson3Transcript(body)
        : parseXmlTranscript(body);
      if (lines.length) return lines;
    } catch {
      /* try next format */
    }
  }
  return [];
}

/** Pull public YouTube captions when available (manual or auto). */
export async function fetchYouTubeTranscript(videoId: string): Promise<{
  text: string;
  source: string;
} | null> {
  const id = parseYouTubeId(videoId);
  if (!id) return null;
  try {
    const trackEntries = await fetchCaptionTracks(id);
    if (!trackEntries.length) {
      console.warn("[research] transcript", id, "no caption tracks");
      return null;
    }
    const preferred = pickCaptionTrack(trackEntries.map((entry) => entry.track), "en");
    const ordered = preferred
      ? [
          ...trackEntries.filter((entry) => entry.track.baseUrl === preferred.baseUrl),
          ...trackEntries.filter((entry) => entry.track.baseUrl !== preferred.baseUrl),
        ]
      : trackEntries;
    const seen = new Set<string>();
    for (const entry of ordered) {
      const url = entry.track.baseUrl;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const lines = await fetchCaptionLines(url, entry.client);
      const text = lines.join("\n").trim();
      if (text) {
        return { text, source: transcriptSourceForTrack(entry.track) };
      }
    }
    console.warn("[research] transcript", id, "empty caption body");
    return null;
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
    if (host.includes("podcast") || host.includes("soundcloud") || host.includes("anchor.fm")) {
      return "audio_podcast";
    }
    if (/\.(mp3|m4a|ogg|opus|wav)(\?|$)/i.test(url)) return "audio_podcast";
  } catch { /* ignore */ }
  return "other";
}
