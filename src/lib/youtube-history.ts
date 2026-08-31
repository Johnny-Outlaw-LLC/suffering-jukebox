export type YouTubeMusicConfidence = "high" | "likely" | "uncertain";
export type YouTubeHistoryCandidate = { videoId: string; url: string; rawTitle: string; channel: string; title: string; artist: string; playedAt: string; confidence: YouTubeMusicConfidence; reason: string };

const NON_MUSIC = /\b(trailer|promo|review|reaction|interview|podcast|tutorial|how to|news|gameplay|episode|shorts?|commercial|documentary|livestream|live stream|speech|debate|highlights?)\b/i;
const MUSIC_TITLE = /\b(official\s+(music\s+)?video|official\s+audio|audio only|lyric(?:s)?\s+video|visuali[sz]er|full album|live at|music video)\b/i;

export function classifyYouTubeMusic(title: string, channel: string) {
  if (/\s+-\s+Topic$/i.test(channel)) return { confidence: "high" as const, reason: "YouTube artist Topic channel" };
  if (/VEVO$/i.test(channel)) return { confidence: "high" as const, reason: "Official VEVO artist channel" };
  if (MUSIC_TITLE.test(title) && !NON_MUSIC.test(title)) return { confidence: "high" as const, reason: "Title identifies a music upload" };
  if (!NON_MUSIC.test(title) && /\s[-–—]\s/.test(title)) return { confidence: "likely" as const, reason: "Artist/title-style upload name" };
  return { confidence: "uncertain" as const, reason: NON_MUSIC.test(title) ? "Title looks like non-music video" : "Google does not label this watch as music" };
}

function cleanTitle(value: string) {
  return value.replace(/\s*[([]\s*(official\s+)?(music\s+)?(video|audio|lyric(?:s)?\s+video|visuali[sz]er)\s*[)\]]\s*$/i, "").trim() || value.trim();
}

export function parseYouTubeTakeoutHtml(html: string): YouTubeHistoryCandidate[] {
  if (typeof DOMParser === "undefined") throw new Error("YouTube history parsing requires a browser.");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: YouTubeHistoryCandidate[] = [];
  for (const cell of Array.from(doc.querySelectorAll(".outer-cell"))) {
    const body = cell.querySelector(".content-cell.mdl-typography--body-1:not(.mdl-typography--text-right)");
    if (!body) continue;
    const links = Array.from(body.querySelectorAll("a"));
    const video = links.find((link) => /youtube\.com\/watch\?/.test(link.href));
    if (!video) continue;
    let parsed: URL;
    try { parsed = new URL(video.href); } catch { continue; }
    const videoId = parsed.searchParams.get("v")?.trim() || "";
    const rawTitle = (video.textContent || "").trim();
    const channelLink = links.find((link) => link !== video && /youtube\.com\/(channel|@)/.test(link.href));
    const channel = (channelLink?.textContent || "Unknown channel").trim();
    const lineReader = document.createElement("div");
    lineReader.innerHTML = body.innerHTML.replace(/<br\s*\/?>/gi, "\n");
    const dateText = (lineReader.textContent || "").split(/\r?\n/).map((line) => line.replace(/^Watched\s*/i, "").trim()).find((line) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4},/i.test(line)) || "";
    const playedMs = Date.parse(dateText.replace(/[\u202f\u00a0]/g, " "));
    if (!videoId || !rawTitle || !Number.isFinite(playedMs)) continue;
    const classification = classifyYouTubeMusic(rawTitle, channel);
    let artist = channel.replace(/\s+-\s+Topic$/i, "").replace(/VEVO$/i, "").trim() || "Unknown artist";
    let title = cleanTitle(rawTitle);
    const split = title.match(/^(.+?)\s[-–—]\s(.+)$/);
    if (split && !/\s+-\s+Topic$/i.test(channel)) { artist = split[1].trim() || artist; title = cleanTitle(split[2]); }
    out.push({ videoId, url: `https://www.youtube.com/watch?v=${videoId}`, rawTitle, channel, title, artist, playedAt: new Date(playedMs).toISOString(), ...classification });
  }
  return out;
}
