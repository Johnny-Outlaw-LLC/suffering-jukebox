// Johnny Outlaw, LLC — Suffering Jukebox — one song, imported properly.
//
// Adding a single song used to write one row to my_jukebox_items and stop
// there, which meant the song existed but its artist did not: nothing appeared
// on Explore Artists, there was no card, no artwork, and two songs by the same
// band sat next to each other as unrelated strangers.
//
// A single now lands in the catalogue the same way an album import does —
// artist, then a "Singles" album, then the track, with the YouTube metrics and
// a track_videos row — so it groups with everything else by that artist and
// gets a card like any other. Visibility is a column on those rows, so a
// private single is the same rows as a public one (see the visibility notes in
// CLAUDE.md); there is no second store.
//
// The personal my_jukebox_items row is still written by the caller. This adds
// the catalogue half; it does not replace the library.

import { JUKEBOX_SCHEMA, type createSjServiceClient } from "@/lib/sj-admin-auth";
import { recordTrackVideo, thumbFor } from "@/lib/track-videos";

type Sb = ReturnType<typeof createSjServiceClient>;
const T = (sb: Sb, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

/** Every single by one artist lands here, so they group into one card. */
export const SINGLES_ALBUM = "Singles";

export type SingleImportInput = {
  videoId: string;
  /** The YouTube title, as uploaded. */
  title: string;
  channelTitle?: string | null;
  thumbnail?: string | null;
  views?: number | null;
  durationMs?: number | null;
  /** What the listener said the artist is called. Wins over anything guessed. */
  artistName?: string | null;
  /** What the listener said the song is called. */
  trackName?: string | null;
  visibility: "public" | "private";
  userEmail: string;
  userName: string | null;
};

export type SingleImportResult = {
  artistId: string;
  artistName: string;
  artistSlug: string;
  albumId: string;
  trackId: string;
  trackName: string;
  duplicate: boolean;
};

// ── Reading a YouTube upload as a record ──────────────────────────────────

const NOISE = [
  /\(official\s*(music\s*)?(video|audio|lyric\s*video)\)/gi,
  /\[official\s*(music\s*)?(video|audio|lyric\s*video)\]/gi,
  /\((official|hq|hd|4k|remaster(ed)?(\s*\d{4})?|audio|lyrics?|visualizer)\)/gi,
  /\[(official|hq|hd|4k|remaster(ed)?(\s*\d{4})?|audio|lyrics?|visualizer)\]/gi,
  /\bofficial\s+(music\s+)?video\b/gi,
  /\bofficial\s+audio\b/gi,
  /\blyric\s*video\b/gi,
  /\|\s*$/,
];

function tidy(s: string): string {
  let out = s;
  for (const rx of NOISE) out = out.replace(rx, " ");
  return out.replace(/\s{2,}/g, " ").replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, "").trim();
}

/** "Band - Topic" is YouTube's own statement of who the artist is. Trust it. */
function fromTopicChannel(channel: string | null | undefined): string | null {
  const m = (channel ?? "").match(/^(.*?)\s*-\s*topic\s*$/i);
  const name = m ? m[1].trim() : "";
  return name || null;
}

/**
 * Split "Artist - Song" the way a person reads it. Deliberately conservative:
 * a title with no separator is left whole and the channel supplies the artist,
 * because half-guessing a band name is worse than saying the channel's.
 */
export function readArtistAndTitle(
  rawTitle: string,
  channelTitle?: string | null,
): { artistName: string; trackName: string } {
  const title = tidy(rawTitle || "");
  const topic = fromTopicChannel(channelTitle);

  // A Topic channel names the artist outright, so the title is the song, minus
  // a leading "Artist - " if the uploader repeated it.
  if (topic) {
    const lead = new RegExp("^" + topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[-–—:]\\s*", "i");
    return { artistName: topic, trackName: tidy(title.replace(lead, "")) || title };
  }

  const parts = title.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const artist = tidy(parts[0]);
    const track = tidy(parts.slice(1).join(" - "));
    if (artist && track && artist.length <= 80) return { artistName: artist, trackName: track };
  }

  const channel = tidy(channelTitle ?? "").replace(/\s*-\s*topic\s*$/i, "").trim();
  return { artistName: channel || "Unknown artist", trackName: title || "Untitled" };
}

export function slugify(name: string): string {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artist";
}

// ── The import ────────────────────────────────────────────────────────────

async function findArtist(sb: Sb, name: string) {
  const { data, error } = await T(sb, "artists")
    .select("id,name,slug,visibility")
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function freeSlug(sb: Sb, base: string): Promise<string> {
  for (let n = 0; n < 30; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const { data, error } = await T(sb, "artists").select("id").eq("slug", slug).maybeSingle();
    if (error) throw error;
    if (!data) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function importSingleTrack(
  sb: Sb,
  input: SingleImportInput,
): Promise<SingleImportResult> {
  const read = readArtistAndTitle(input.title, input.channelTitle);
  const artistName = (input.artistName || read.artistName).trim() || "Unknown artist";
  const trackName = (input.trackName || read.trackName).trim() || "Untitled";
  const art = thumbFor(input.videoId, input.thumbnail);

  // ── Artist. An artist that already exists keeps the visibility it has: a
  // private single must never drag somebody else's public artist out of the
  // catalogue, and a public one must not expose a private import.
  let artist = await findArtist(sb, artistName);
  if (!artist) {
    const slug = await freeSlug(sb, slugify(artistName));
    const { data, error } = await T(sb, "artists")
      .insert({
        name: artistName,
        slug,
        is_community: true,
        added_by: input.userEmail,
        added_by_name: input.userName,
        visibility: input.visibility,
        // One song is never the discography, so the card offers to finish it.
        discography_complete: false,
      })
      .select("id,name,slug,visibility")
      .single();
    if (error) throw error;
    artist = data;
  }

  // Rights are recorded for every import, public or private, so the importer
  // can always see their own music even after somebody flips it private.
  await T(sb, "content_access")
    .insert({ artist_id: artist.id, user_email: input.userEmail.toLowerCase() })
    .then(() => undefined, () => undefined);

  // ── Album. One "Singles" record per artist, so every loose song by that
  // artist groups under one cover instead of minting an album each time.
  let albumId: string;
  const { data: album, error: albumErr } = await T(sb, "albums")
    .select("id,art_url")
    .eq("artist_id", artist.id)
    .ilike("name", SINGLES_ALBUM)
    .maybeSingle();
  if (albumErr) throw albumErr;
  if (album) {
    albumId = album.id;
    // The first single supplies the cover; later ones do not overwrite it.
    if (!album.art_url) await T(sb, "albums").update({ art_url: art }).eq("id", albumId);
  } else {
    const { data, error } = await T(sb, "albums")
      .insert({
        artist_id: artist.id,
        name: SINGLES_ALBUM,
        added_by: input.userEmail,
        added_by_name: input.userName,
        art_url: art,
        visibility: artist.visibility ?? input.visibility,
      })
      .select("id")
      .single();
    if (error) throw error;
    albumId = data.id;
  }

  // ── Track. Same video already here means this is a repeat, not a new song.
  const { data: seen, error: seenErr } = await T(sb, "track_videos")
    .select("track_id,tracks!inner(id,name,album_id)")
    .eq("video_id", input.videoId)
    .eq("tracks.album_id", albumId)
    .limit(1)
    .maybeSingle();
  if (seenErr) throw seenErr;
  if (seen) {
    return {
      artistId: artist.id,
      artistName: artist.name,
      artistSlug: artist.slug,
      albumId,
      trackId: (seen as any).track_id,
      trackName: (seen as any).tracks?.name ?? trackName,
      duplicate: true,
    };
  }

  const { count } = await T(sb, "tracks")
    .select("id", { count: "exact", head: true })
    .eq("album_id", albumId);

  const { data: track, error: trackErr } = await T(sb, "tracks")
    .insert({
      album_id: albumId,
      name: trackName,
      track_number: (count ?? 0) + 1,
      disc_number: 1,
      duration_ms: input.durationMs ?? null,
      explicit: false,
      yt_snapshot_enabled: true,
      visibility: artist.visibility ?? input.visibility,
    })
    .select("id")
    .single();
  if (trackErr) throw trackErr;

  // ── The numbers the charts read. Same shape the album importer writes, so
  // a single appears on the bars exactly like anything else.
  const now = new Date().toISOString();
  const base = {
    track_id: track.id,
    album_id: null,
    artist_id: null,
    metric_source: "youtube",
    metric_date: now,
    metric_type: "track",
    metric_value: null as number | null,
    metric_text_value: null as string | null,
  };
  await T(sb, "metrics").insert([
    { ...base, metric_name: "youtube_video_id", metric_text_value: input.videoId },
    { ...base, metric_name: "youtube_views", metric_value: input.views ?? 0 },
    { ...base, metric_name: "youtube_thumbnail", metric_text_value: art },
    { ...base, metric_name: "youtube_title", metric_text_value: input.title },
    { ...base, metric_name: "youtube_channel", metric_text_value: input.channelTitle ?? "" },
  ]);

  await recordTrackVideo(
    sb,
    track.id,
    {
      videoId: input.videoId,
      title: input.title,
      channel: input.channelTitle ?? null,
      thumbnail: art,
      views: input.views ?? null,
      playable: true,
    },
    {
      makePrimary: true,
      source: "community",
      addedBy: input.userEmail,
      addedByName: input.userName,
      artistName,
      countsForCharts: true,
    },
  );

  return {
    artistId: artist.id,
    artistName: artist.name,
    artistSlug: artist.slug,
    albumId,
    trackId: track.id,
    trackName,
    duplicate: false,
  };
}
