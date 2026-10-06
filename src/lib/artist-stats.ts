// Johnny Outlaw, LLC — artist stats helpers shared by /api/artist-stats.
// Pure functions, no database: the route feeds them what artist_stats() returned.

export type Referrer = { host: string; visits: number };

/**
 * The lyric being sung in a 10-second heart window, from timestamped lyrics:
 * the line on screen at the window's midpoint, or the first line to start
 * inside the window when it opens before the singing does.
 */
export function lyricAt(lrc: string | null | undefined, startMs: number): string | null {
  if (!lrc) return null;
  const lines: { t: number; text: string }[] = [];
  for (const line of lrc.split(/\r?\n/)) {
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) continue;
    for (const m of line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
      const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
      lines.push({ t: Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac, text });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  const mid = startMs + 5000;
  const onScreen = lines.filter((l) => l.t <= mid).pop();
  // A line that started long before is an instrumental break, not a lyric.
  if (onScreen && mid - onScreen.t <= 20000) return onScreen.text;
  return lines.find((l) => l.t > mid - 5000 && l.t < startMs + 10000)?.text ?? null;
}

/** Turn referrer hosts into the places an artist would recognise. */
const SOURCES: [RegExp, string][] = [
  [/(^|\.)(facebook\.com|fb\.me|fb\.com)$/, "Facebook"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)threads\.(net|com)$/, "Threads"],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "X"],
  [/(^|\.)bsky\.(app|social)$/, "Bluesky"],
  [/(^|\.)reddit\.com$/, "Reddit"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
  [/(^|\.)google\.[a-z.]+$/, "Google"],
  [/(^|\.)(bing\.com|duckduckgo\.com|search\.yahoo\.com|search\.brave\.com)$/, "Other search"],
  [/(^|\.)spotify\.com$/, "Spotify"],
  // Our own hosts, plus local and preview builds someone was testing on.
  [/(^|\.)(listeningparty\.stream|sufferingjukebox\.stream|vercel\.app)$|^(localhost|127\.0\.0\.1)(:\d+)?$/, "Inside Listening Party"],
];

export function groupReferrers(rows: Referrer[]) {
  const out = new Map<string, number>();
  for (const r of rows) {
    const host = (r.host || "").toLowerCase();
    let label: string;
    if (host === "(direct)") label = "Direct link or typed in";
    else if (host === "(internal)") label = "Inside Listening Party";
    else label = SOURCES.find(([re]) => re.test(host))?.[1] ?? host.replace(/^www\./, "");
    out.set(label, (out.get(label) || 0) + (Number(r.visits) || 0));
  }
  return [...out.entries()]
    .map(([source, visits]) => ({ source, visits }))
    .sort((a, b) => b.visits - a.visits);
}
