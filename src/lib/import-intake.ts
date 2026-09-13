// What did somebody put into Add music?
//
// One box takes a YouTube link, a song, an artist, or a whole list of songs
// copied out of Notes, a text message or a video description. Everything that
// decides which of those it is, and how a line of text becomes an artist and a
// title, lives here: pure functions, no I/O, covered by
// tests/import-intake.test.mjs. The intake route and the screenshot route both
// read from it, so a list typed in and a list read off a picture follow the same
// rules.

export const MAX_INTAKE_CHARS = 20_000;
export const MAX_INTAKE_SONGS = 200;

export type YouTubeLink =
  | { type: "video"; videoId: string; playlistId: string | null }
  | { type: "playlist"; playlistId: string }
  | { type: "channel"; url: string };

export type IntakeSong = {
  /** The line as it will be shown back, cleaned of numbering and timestamps. */
  line: string;
  artist: string | null;
  title: string;
  /**
   * "A - B" is Artist - Title on YouTube and Title - Artist in half the lists
   * people type, so the matcher tries both ways round. "Title by Artist" is not
   * ambiguous and is not swapped.
   */
  swappable: boolean;
  /** Set when the line was a YouTube video link rather than words. */
  videoId: string | null;
};

export type Intake =
  | { kind: "empty"; reason: "nothing" | "unsupported-link" }
  | { kind: "link"; link: YouTubeLink }
  | { kind: "songs"; songs: IntakeSong[]; truncated: boolean }
  | { kind: "query"; query: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const YT_URL_IN_TEXT =
  /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s<>"')\]]*/i;
const ANY_URL = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * The YouTube link inside a piece of text, if there is one. Text is allowed
 * around it because a phone's share sheet sends "Check out this video" with
 * the link. A bare 11 character id is deliberately NOT a video here: in a box
 * that also takes song titles, "Pavementrox" is a word.
 */
export function parseYouTubeLink(input: string): YouTubeLink | null {
  const found = String(input || "").match(YT_URL_IN_TEXT);
  if (!found) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(found[0]) ? found[0] : "https://" + found[0]);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const list = url.searchParams.get("list");
  // A radio mix ("RD...") is generated per listener and cannot be fetched.
  const playlistId = list && LIST_ID.test(list) && !/^RD/.test(list) ? list : null;

  if (host === "youtu.be") {
    return parts[0] && VIDEO_ID.test(parts[0]) ? { type: "video", videoId: parts[0], playlistId } : null;
  }
  if (!/^youtube(?:-nocookie)?\.com$/.test(host)) return null;

  const v = url.searchParams.get("v");
  if (parts[0] === "watch" && v && VIDEO_ID.test(v)) return { type: "video", videoId: v, playlistId };
  if (["shorts", "embed", "live", "v"].includes(parts[0]) && parts[1] && VIDEO_ID.test(parts[1])) {
    return { type: "video", videoId: parts[1], playlistId };
  }
  if (parts[0] === "playlist" && playlistId) return { type: "playlist", playlistId };
  if (parts[0]?.startsWith("@")) return { type: "channel", url: `https://www.youtube.com/${parts[0]}` };
  if (["channel", "c", "user"].includes(parts[0]) && parts[1]) {
    return { type: "channel", url: `https://www.youtube.com/${parts[0]}/${parts[1]}` };
  }
  return null;
}

const BULLET = /^[-*•·▪►▶♪♫✓✔☐☑>\s]+/;
// "1." "01)" "#3:" but never "99 Problems": numbering needs its punctuation.
const NUMBERED = /^(?:#\s*)?\(?\d{1,3}\s*[.):\]]\s+/;
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const LEAD_TIME = new RegExp(String.raw`^[\[(]?${TIME}[\])]?\s*(?:[-–—|:]\s*)?`);
const TRAIL_TIME = new RegExp(String.raw`\s*(?:[-–—|]\s*)?[\[(]?${TIME}[\])]?$`);
const QUOTES = /^["“”'‘’]+|["“”'‘’]+$/g;
const HEADER =
  /^(?:track\s*list(?:ing)?|set\s*list|play\s*list|songs?|tracks?|encore|side\s+[a-d12]|dis[ck]\s*\d+|cd\s*\d+)\s*:?$/i;

/** One line of a pasted list with its numbering, bullets and timestamps taken off. */
export function cleanLine(raw: string): string {
  let s = String(raw || "").replace(/[^\S\t]+/g, " ").trim();
  s = s.replace(BULLET, "");
  s = s.replace(LEAD_TIME, "");
  s = s.replace(NUMBERED, "");
  s = s.replace(LEAD_TIME, "");
  s = s.replace(TRAIL_TIME, "");
  return s.replace(QUOTES, "").trim();
}

function isNoise(line: string): boolean {
  if (!line || line.length > 200) return true;
  if (!/\p{L}/u.test(line)) return true;
  if (HEADER.test(line)) return true;
  // "Encore:" or "Tonight's setlist:" introduce the songs; they are not one.
  if (/:$/.test(line) && line.split(/\s+/).length <= 4) return true;
  return false;
}

const SEPARATORS = ["\t", " – ", " — ", " - ", " | ", " ~ "];

/** A single line as a song, or null when it is a header, a blank or noise. */
export function songFromLine(raw: string): IntakeSong | null {
  const link = parseYouTubeLink(raw);
  if (link?.type === "video") {
    return { line: String(raw).trim(), artist: null, title: "", swappable: false, videoId: link.videoId };
  }
  const line = cleanLine(raw);
  if (ANY_URL.test(line)) return null;
  if (isNoise(line)) return null;

  for (const sep of SEPARATORS) {
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    const left = line.slice(0, at).trim();
    const right = line.slice(at + sep.length).trim();
    if (left && right) {
      return { line: line.replace(/\t+/g, " - "), artist: left, title: right, swappable: true, videoId: null };
    }
  }
  const by = line.match(/^(.+?)\s+by\s+(.+)$/i);
  if (by) return { line, artist: by[2].trim(), title: by[1].trim(), swappable: false, videoId: null };
  return { line, artist: null, title: line, swappable: false, videoId: null };
}

/**
 * Every reading of a song worth asking the catalogue about, best guess first.
 * The whole line as a title is always last, because "Stand by Me" is a title
 * and not a song called Stand by an artist called Me.
 */
export function songCandidates(song: IntakeSong): { artist?: string; title: string }[] {
  if (!song.title) return [];
  const out: { artist?: string; title: string }[] = [
    song.artist ? { artist: song.artist, title: song.title } : { title: song.title },
  ];
  if (song.artist && song.swappable) out.push({ artist: song.title, title: song.artist });
  if (song.artist && song.line !== song.title) out.push({ title: song.line });
  return out;
}

/** The words to search YouTube with. Word order barely matters to YouTube. */
export function songQuery(song: IntakeSong): string {
  if (!song.artist) return song.title;
  return `${song.artist} ${song.title}`.replace(/\s+/g, " ").trim();
}

/** What a pasted block of text is. */
export function parseIntake(text: string): Intake {
  const input = String(text || "").slice(0, MAX_INTAKE_CHARS);
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { kind: "empty", reason: "nothing" };

  // One link, perhaps with the sentence a share sheet puts in front of it. A
  // line beside it that reads like a song ("Artist - Title") is a second song,
  // not chatter, or pasting a two-song list would silently lose one.
  const linkLines = lines.filter((l) => parseYouTubeLink(l));
  const chatter = lines.filter((l) => !parseYouTubeLink(l));
  if (
    lines.length <= 2 &&
    linkLines.length === 1 &&
    !chatter.some((l) => SEPARATORS.some((sep) => cleanLine(l).indexOf(sep) > 0))
  ) {
    const link = parseYouTubeLink(input);
    if (link) return { kind: "link", link };
  }

  const songs: IntakeSong[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const raw of lines) {
    const song = songFromLine(raw);
    if (!song) continue;
    const key = song.videoId || song.line.toLowerCase();
    if (seen.has(key)) continue;
    if (songs.length >= MAX_INTAKE_SONGS) { truncated = true; break; }
    seen.add(key);
    songs.push(song);
  }
  if (!songs.length) {
    return { kind: "empty", reason: lines.some((l) => ANY_URL.test(l)) ? "unsupported-link" : "nothing" };
  }
  // A single line with no separator is a search: an artist, or a song title.
  if (lines.length === 1 && songs.length === 1 && !songs[0].artist && !songs[0].videoId) {
    return { kind: "query", query: songs[0].title };
  }
  return { kind: "songs", songs, truncated };
}

/** Artist and title pairs read off a screenshot, shaped like typed lines. */
export function songsFromPairs(pairs: { artist?: unknown; title?: unknown }[]): IntakeSong[] {
  const out: IntakeSong[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const title = cleanLine(String(p?.title ?? ""));
    const artist = cleanLine(String(p?.artist ?? "")) || null;
    if (!title || !/[\p{L}\p{N}]/u.test(title)) continue;
    const line = artist ? `${artist} - ${title}` : title;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, artist, title, swappable: false, videoId: null });
    if (out.length >= MAX_INTAKE_SONGS) break;
  }
  return out;
}
