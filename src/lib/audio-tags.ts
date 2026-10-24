/**
 * What an artist's own files already say about themselves, read in the
 * browser before anything uploads. Bandcamp and SoundCloud both prefill from
 * the file; asking an artist to retype a tracklist their ripper or DAW already
 * wrote is most of what made the old upload form feel like paperwork.
 *
 * Pure parsing lives in parseId3 / parseFlac / planReleases so it can be
 * tested without a browser. readAudioTags is the only part that touches a
 * File, and it reads slices, never the whole song.
 *
 * public/index.html has its own taReadId3 for the private batch matcher. That
 * one reads only title/artist/album/length and deliberately skips cover art;
 * this one needs track numbers, years and the picture.
 */

export type AudioTags = {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: string;
  track?: number;
  disc?: number;
  picture?: { mime: string; bytes: Uint8Array };
};

/** Cover art sits inside the tag, so this has to allow for a large image. */
const MAX_TAG_BYTES = 16 * 1024 * 1024;

/**
 * What a browser can play, because the file we keep is the file that streams:
 * nothing is transcoded. AIFF and WMA are named separately so the page can say
 * "export it as WAV or FLAC" instead of silently ignoring the file.
 */
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "webm"];
export const UNPLAYABLE_AUDIO_EXTENSIONS = ["aif", "aiff", "aifc", "wma", "ape", "alac", "dsf"];
const COVER_NAMES = /^(cover|folder|front|album|artwork)\.(jpe?g|png|webp)$/i;

export function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

export function isAudioFileName(name: string): boolean {
  return AUDIO_EXTENSIONS.includes(extensionOf(name));
}

export function isCoverFileName(name: string): boolean {
  return COVER_NAMES.test(name.split(/[\\/]/).pop() ?? "");
}

function clean(value: string | undefined): string | undefined {
  const out = (value ?? "").replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  return out || undefined;
}

/** "3/12" and "3" both mean track 3. */
function leadingNumber(value: string | undefined): number | undefined {
  const n = Number((value ?? "").match(/^\s*(\d{1,3})/)?.[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function yearOf(value: string | undefined): string | undefined {
  return (value ?? "").match(/\b(1[89]\d\d|20\d\d)\b/)?.[1];
}

function decodeText(bytes: Uint8Array, enc: number): string {
  try {
    if (enc === 1 || enc === 2) {
      const le = enc === 1 && bytes[0] === 0xff && bytes[1] === 0xfe;
      const be = enc === 2 || (enc === 1 && bytes[0] === 0xfe && bytes[1] === 0xff);
      const body = enc === 1 && (le || be) ? bytes.subarray(2) : bytes;
      return new TextDecoder(be ? "utf-16be" : "utf-16le").decode(body);
    }
    return new TextDecoder(enc === 3 ? "utf-8" : "iso-8859-1").decode(bytes);
  } catch { return ""; }
}

/** Index just past a terminator, which is two zero bytes for UTF-16. */
function skipTerminated(bytes: Uint8Array, from: number, enc: number): number {
  const wide = enc === 1 || enc === 2;
  for (let i = from; i < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) return i + (wide ? 2 : 1);
  }
  return bytes.length;
}

function syncsafe(b: Uint8Array, at: number): number {
  return ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
}

/** Total length of an ID3v2 tag from its 10 byte header, or 0 when there is none. */
export function id3Size(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  return 10 + syncsafe(head, 6);
}

/**
 * ID3v2.2, 2.3 and 2.4. They differ in frame id length (3 or 4), and in
 * whether frame sizes are syncsafe (2.4 only), and all three are still in the
 * wild. `tag` is the whole tag including its 10 byte header.
 */
export function parseId3(tag: Uint8Array): AudioTags | null {
  const size = id3Size(tag);
  if (!size) return null;
  const major = tag[3];
  const buf = tag.subarray(10, Math.min(size, tag.length));
  const short = major <= 2;
  const idLen = short ? 3 : 4;
  const headerLen = short ? 6 : 10;
  const text: Record<string, string> = short
    ? { TT2: "title", TP1: "artist", TP2: "albumArtist", TAL: "album", TYE: "year", TRK: "track", TPA: "disc" }
    : { TIT2: "title", TPE1: "artist", TPE2: "albumArtist", TALB: "album", TYER: "year", TDRC: "year",
        TRCK: "track", TPOS: "disc" };
  const raw: Record<string, string> = {};
  const out: AudioTags = {};
  let at = 0;
  while (at + headerLen <= buf.length) {
    let id = "";
    for (let i = 0; i < idLen; i++) id += String.fromCharCode(buf[at + i]);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding, or we walked off the end
    let len: number;
    if (short) len = (buf[at + 3] << 16) | (buf[at + 4] << 8) | buf[at + 5];
    else if (major === 4) len = syncsafe(buf, at + 4);
    else len = buf[at + 4] * 0x1000000 + (buf[at + 5] << 16) + (buf[at + 6] << 8) + buf[at + 7];
    if (!(len > 0) || at + headerLen + len > buf.length) break;
    const body = buf.subarray(at + headerLen, at + headerLen + len);
    const key = text[id];
    if (key && len > 1 && !raw[key]) raw[key] = decodeText(body.subarray(1), body[0]);
    if ((id === "APIC" || id === "PIC") && !out.picture && len > 4) {
      const enc = body[0];
      let mime: string;
      let p: number;
      if (id === "PIC") { // v2.2: a three letter image format, not a MIME type
        mime = String.fromCharCode(body[1], body[2], body[3]).toUpperCase() === "PNG" ? "image/png" : "image/jpeg";
        p = 4;
      } else {
        const end = skipTerminated(body, 1, 0);
        mime = new TextDecoder("iso-8859-1").decode(body.subarray(1, end - 1)).toLowerCase();
        p = end;
      }
      p = skipTerminated(body, p + 1, enc); // picture type byte, then description
      if (mime === "image/jpg") mime = "image/jpeg";
      if (!mime.includes("/")) mime = "image/" + (mime || "jpeg");
      if (p < body.length) out.picture = { mime, bytes: body.slice(p) };
    }
    at += headerLen + len;
  }
  out.title = clean(raw.title);
  out.artist = clean(raw.artist);
  out.albumArtist = clean(raw.albumArtist);
  out.album = clean(raw.album);
  out.year = yearOf(raw.year);
  out.track = leadingNumber(raw.track);
  out.disc = leadingNumber(raw.disc);
  return out;
}

/** The 128 bytes on the end of an old MP3, for files ripped before ID3v2. */
export function parseId3v1(tail: Uint8Array): AudioTags | null {
  if (tail.length !== 128 || tail[0] !== 0x54 || tail[1] !== 0x41 || tail[2] !== 0x47) return null;
  const dec = new TextDecoder("iso-8859-1");
  const read = (at: number, n: number) => clean(dec.decode(tail.subarray(at, at + n)));
  // ID3v1.1 puts the track number in the last byte of the comment.
  const track = tail[125] === 0 && tail[126] > 0 ? tail[126] : undefined;
  return { title: read(3, 30), artist: read(33, 30), album: read(63, 30), year: yearOf(read(93, 4)), track };
}

/**
 * FLAC: "fLaC", then metadata blocks. Block 4 is Vorbis comments (little
 * endian lengths, KEY=value), block 6 is a picture. `head` must cover every
 * metadata block, which readAudioTags arranges.
 */
export function parseFlac(head: Uint8Array): AudioTags | null {
  if (head.length < 8 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const utf8 = new TextDecoder("utf-8");
  const fields: Record<string, string> = {};
  const out: AudioTags = {};
  let at = 4;
  for (;;) {
    if (at + 4 > head.length) break;
    const last = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const len = (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3];
    const start = at + 4;
    if (start + len > head.length) break;
    if (type === 4) {
      let p = start;
      const vendor = view.getUint32(p, true); p += 4 + vendor;
      const count = view.getUint32(p, true); p += 4;
      for (let i = 0; i < count && p + 4 <= start + len; i++) {
        const n = view.getUint32(p, true); p += 4;
        const entry = utf8.decode(head.subarray(p, p + n)); p += n;
        const eq = entry.indexOf("=");
        if (eq > 0) {
          const key = entry.slice(0, eq).toUpperCase();
          if (!fields[key]) fields[key] = entry.slice(eq + 1);
        }
      }
    } else if (type === 6 && !out.picture) {
      let p = start + 4; // picture type
      const mimeLen = view.getUint32(p, false); p += 4;
      const mime = utf8.decode(head.subarray(p, p + mimeLen)).toLowerCase(); p += mimeLen;
      const descLen = view.getUint32(p, false); p += 4 + descLen + 16; // description, then width/height/depth/colours
      const dataLen = view.getUint32(p, false); p += 4;
      if (p + dataLen <= start + len) out.picture = { mime: mime === "image/jpg" ? "image/jpeg" : mime, bytes: head.slice(p, p + dataLen) };
    }
    at = start + len;
    if (last) break;
  }
  out.title = clean(fields.TITLE);
  out.artist = clean(fields.ARTIST);
  out.albumArtist = clean(fields.ALBUMARTIST ?? fields["ALBUM ARTIST"]);
  out.album = clean(fields.ALBUM);
  out.year = yearOf(fields.DATE ?? fields.YEAR);
  out.track = leadingNumber(fields.TRACKNUMBER);
  out.disc = leadingNumber(fields.DISCNUMBER);
  return out;
}

/** Where a FLAC file's metadata ends, walking block headers only. */
async function flacMetadataEnd(file: Blob): Promise<number> {
  let at = 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = new Uint8Array(await file.slice(at, at + 4).arrayBuffer());
    if (h.length < 4) return at;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    at += 4 + len;
    if (h[0] & 0x80) return at;
  }
  return at;
}

export async function readAudioTags(file: Blob): Promise<AudioTags | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    const size = id3Size(head);
    if (size && size <= MAX_TAG_BYTES) {
      const tags = parseId3(new Uint8Array(await file.slice(0, size).arrayBuffer()));
      if (tags && (tags.title || tags.artist || tags.album)) return tags;
    }
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      const end = await flacMetadataEnd(file);
      if (end <= MAX_TAG_BYTES) return parseFlac(new Uint8Array(await file.slice(0, end).arrayBuffer()));
    }
    if (file.size >= 128) return parseId3v1(new Uint8Array(await file.slice(file.size - 128).arrayBuffer()));
  } catch { /* an unreadable tag is the same as no tag */ }
  return null;
}

/**
 * "03 - Song Name.wav" -> 3 and "Song Name", "1-03 Song" -> 3. A dash later
 * in the name is left alone: an artist's own export is "Song - Live" far more
 * often than "Artist - Song".
 */
export function guessFromFileName(name: string): { title: string; track?: number } {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/_/g, " ").trim();
  // A bare number before a space only counts with a leading zero or a disc
  // prefix, or "99 Problems" would come back as track 99, "Problems".
  const numbered = base.match(/^\d{1,2}-(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/)
    ?? base.match(/^(\d{1,3})\s*[-.)]+\s*(.+)$/)
    ?? base.match(/^(0\d{1,2})\s+(.+)$/);
  const track = numbered ? Number(numbered[1]) : undefined;
  const title = (numbered ? numbered[2] : base).trim();
  return { title: title || base, track: track && track > 0 ? track : undefined };
}

export type PlannedFile = {
  /** The browser's relative path when a folder was picked, else the name. */
  path: string;
  size: number;
  tags: AudioTags | null;
};

export type PlannedTrack = { file: number; title: string; number: number; disc: number };

export type PlannedRelease = {
  key: string;
  title: string;
  artist: string;
  year?: string;
  tracks: PlannedTrack[];
  /** Index of a file whose embedded picture can be the cover. */
  pictureFrom?: number;
  /** Folder of the release, used to find a cover.jpg beside the songs. */
  folder: string;
};

function folderOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function mostCommon(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Turns a pile of files into releases. A whole discography dropped as one
 * folder is the case this exists for: the album tag decides which songs go
 * together, and the folder decides when there is no tag. Track numbers come
 * from the tag when every song on the release has a distinct one, otherwise
 * from the order of the file names, which is how every ripper numbers them.
 */
export function planReleases(files: PlannedFile[]): PlannedRelease[] {
  const groups = new Map<string, number[]>();
  files.forEach((f, i) => {
    const folder = folderOf(f.path);
    const album = f.tags?.album;
    const key = album ? `album:${album.toLowerCase()}` : `folder:${folder.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const releases: PlannedRelease[] = [];
  for (const [key, idx] of groups) {
    const sorted = [...idx].sort((a, b) => {
      const ta = files[a].tags, tb = files[b].tags;
      return ((ta?.disc ?? 1) - (tb?.disc ?? 1))
        || files[a].path.localeCompare(files[b].path, undefined, { numeric: true });
    });
    const named = sorted.map((i) => ({ i, guess: guessFromFileName(files[i].path.split(/[\\/]/).pop() ?? "") }));
    const tagNumbers = named.map(({ i }) => {
      const t = files[i].tags;
      return t?.track ? (t.disc ?? 1) * 1000 + t.track : undefined;
    });
    const useTags = tagNumbers.every(Boolean) && new Set(tagNumbers).size === tagNumbers.length;
    const ordered = useTags ? [...named].sort((a, b) => tagNumbers[named.indexOf(a)]! - tagNumbers[named.indexOf(b)]!) : named;
    const tracks = ordered.map(({ i, guess }, n) => ({
      file: i,
      title: files[i].tags?.title || guess.title,
      number: n + 1,
      disc: 1,
    }));
    const tagsOf = idx.map((i) => files[i].tags);
    const folder = folderOf(files[idx[0]].path);
    const folderName = folder.split("/").pop() ?? "";
    releases.push({
      key,
      title: mostCommon(tagsOf.map((t) => t?.album)) || folderName || (tracks.length === 1 ? tracks[0].title : "Untitled release"),
      artist: mostCommon(tagsOf.map((t) => t?.albumArtist)) || mostCommon(tagsOf.map((t) => t?.artist)) || "",
      year: mostCommon(tagsOf.map((t) => t?.year)),
      tracks,
      pictureFrom: idx.find((i) => files[i].tags?.picture),
      folder,
    });
  }
  return releases.sort((a, b) => (a.year ?? "9999").localeCompare(b.year ?? "9999") || a.title.localeCompare(b.title));
}
