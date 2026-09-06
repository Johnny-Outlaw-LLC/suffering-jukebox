// Johnny Outlaw, LLC — Suffering Jukebox — "Download my data".
//
// Four datasets, one shape of answer: a flat table a person can open in a
// spreadsheet. Every dataset carries a YouTube link, because the link is the
// only column that survives leaving this site — a title and an artist are a
// search, a watch URL is the song.
//
// Rows are produced as async generators rather than arrays so the route can
// stream them out. A full listening history is tens of thousands of rows and a
// function response that is not streamed is capped well below that.

import { JUKEBOX_SCHEMA, type createSjServiceClient } from "@/lib/sj-admin-auth";
import { normTitle } from "@/lib/catalog-index";
import { approvedArtistAudioTracks } from "@/lib/bg-audio-eligibility";

type Sb = ReturnType<typeof createSjServiceClient>;
const T = (sb: Sb, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

export const DATASETS = ["music", "playlists", "songs", "history"] as const;
export type Dataset = (typeof DATASETS)[number];

export const DATASET_LABEL: Record<Dataset, string> = {
  music: "My Music",
  playlists: "My Playlists",
  songs: "My Songs",
  history: "My Listening History",
};

export const DATASET_FILE: Record<Dataset, string> = {
  music: "my-music",
  playlists: "my-playlists",
  songs: "my-songs",
  history: "my-listening-history",
};

export function isDataset(value: unknown): value is Dataset {
  return typeof value === "string" && (DATASETS as readonly string[]).includes(value);
}

export function watchUrl(videoId: string | null | undefined) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}
function channelUrl(channelId: string | null | undefined) {
  return channelId ? `https://www.youtube.com/channel/${channelId}` : "";
}
function listUrl(playlistId: string | null | undefined) {
  return playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : "";
}

/* ilike is a case-insensitive LIKE, so an email holding "_" or "%" would
   otherwise match somebody else's address one character away. Backslash is
   the escape character PostgREST passes through to SQL. */
function likeSafe(email: string) {
  return email.replace(/[\\%_]/g, (char) => "\\" + char);
}

/* PostgREST answers a page at a time, so every read here is paged. Every one
   of them ends in a UNIQUE sort key: a range over an unordered query is free
   to return a row twice and skip another, which showed up as songs quietly
   missing their YouTube link. The cap is a backstop against a runaway
   account, not a product limit. */
const PAGE = 1000;
const ROW_CAP = 250_000;

async function pageAll<T = Record<string, unknown>>(
  read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  cap = ROW_CAP,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Filters                                                            */
/* ------------------------------------------------------------------ */

export type BackgroundFilter = "any" | "yes" | "no";

export type ExportFilters = {
  /** Artist names as the person picked or typed them. Empty means every artist. */
  artists: string[];
  /** Playlist names. Empty means every playlist. Only narrows My Playlists. */
  playlists: string[];
  background: BackgroundFilter;
};

export const NO_FILTERS: ExportFilters = { artists: [], playlists: [], background: "any" };

/* Names, never ids. An imported Spotify play carries its artist as text and
   nothing else, so an id-based artist filter would silently drop the half of a
   listening history that never matched the catalogue. */
export function foldName(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function nameList(value: unknown, cap = 400) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const label = String(item ?? "").trim();
    const key = foldName(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= cap) break;
  }
  return out;
}

export function readFilters(value: unknown): ExportFilters {
  const input = (value || {}) as Record<string, unknown>;
  const background = input.background;
  return {
    artists: nameList(input.artists),
    playlists: nameList(input.playlists),
    background: background === "yes" || background === "no" ? background : "any",
  };
}

export function anyFilterSet(filters: ExportFilters) {
  return filters.artists.length > 0 || filters.playlists.length > 0 || filters.background !== "any";
}

export function describeFilters(dataset: Dataset, filters: ExportFilters) {
  const parts: string[] = [];
  if (filters.artists.length) parts.push(`artist ${filters.artists.join(", ")}`);
  // A playlist choice is named even on the three files it cannot narrow, so a
  // My Music export does not read as one that quietly obeyed it.
  if (filters.playlists.length) {
    parts.push(dataset === "playlists"
      ? `playlist ${filters.playlists.join(", ")}`
      : "playlist (which does not narrow this file)");
  }
  if (filters.background === "yes") parts.push("songs with background audio only");
  if (filters.background === "no") parts.push("songs without background audio only");
  return parts.length ? ` Filtered by ${parts.join("; ")}.` : "";
}

type Prepared = {
  artists: Set<string> | null;
  playlists: Set<string> | null;
  background: BackgroundFilter;
};

function prepare(filters: ExportFilters): Prepared {
  return {
    artists: filters.artists.length ? new Set(filters.artists.map(foldName)) : null,
    playlists: filters.playlists.length ? new Set(filters.playlists.map(foldName)) : null,
    background: filters.background,
  };
}

/** Does one row survive the artist and background-audio filters. */
function keepRow(prepared: Prepared, artist: string | null | undefined, hasBackground: boolean) {
  if (prepared.artists && !prepared.artists.has(foldName(artist))) return false;
  if (prepared.background === "yes" && !hasBackground) return false;
  if (prepared.background === "no" && hasBackground) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* The catalogue, once                                                */
/* ------------------------------------------------------------------ */

export type CatalogTrack = {
  id: string;
  name: string;
  albumName: string;
  albumReleaseDate: string | null;
  albumPlaylistId: string | null;
  artistId: string | null;
  artistName: string;
  artistChannelId: string | null;
  visibility: string;
  trackNumber: number | null;
  discNumber: number | null;
  durationMs: number | null;
  createdAt: string | null;
  videoId: string | null;
  videoViews: number | null;
  videoPlayable: boolean | null;
};

type Catalog = {
  byTrackId: Map<string, CatalogTrack>;
  /** normalised "artist title" -> a track we hold a playable video for. */
  byName: Map<string, CatalogTrack>;
  artistIdsAddedBy: (email: string) => Set<string>;
};

// Five minutes, matching catalogIndex. An export is a deliberate, occasional
// act; paging the whole catalogue on every click would be the expensive part
// of it, and a song imported ninety seconds ago missing from one download is
// not worth that.
const TTL_MS = 5 * 60 * 1000;
let cached: { at: number; catalog: Catalog } | null = null;

export function invalidateExportCatalog() { cached = null; }

function nameKey(artist: string, title: string) {
  const a = normTitle(artist);
  const t = normTitle(title);
  return a && t ? `${a} ${t}` : "";
}

type ArtistRow = { id: string; name: string | null; yt_channel_id: string | null; visibility: string | null; added_by: string | null };
type AlbumRow = { id: string; name: string | null; artist_id: string | null; release_date: string | null; yt_playlist_id: string | null; added_by: string | null };
type TrackRow = { id: string; name: string | null; album_id: string | null; track_number: number | null; disc_number: number | null; duration_ms: number | null; created_at: string | null; visibility: string | null };
type VideoRow = { track_id: string; video_id: string | null; view_count: number | null; is_playable: boolean | null; is_primary: boolean | null };

/* Which upload to print for a song. The primary one is what the site plays,
   so it wins outright; thirty tracks have alternates and no primary, and for
   those a playable, well-watched upload is a better link than none. */
function betterVideo(a: VideoRow, b: VideoRow) {
  if (!!a.is_primary !== !!b.is_primary) return a.is_primary ? a : b;
  if ((a.is_playable !== false) !== (b.is_playable !== false)) return a.is_playable !== false ? a : b;
  return (Number(a.view_count) || 0) >= (Number(b.view_count) || 0) ? a : b;
}

async function loadCatalog(sb: Sb): Promise<Catalog> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.catalog;

  const [artists, albums, tracks, videos] = await Promise.all([
    pageAll<ArtistRow>((from, to) => T(sb, "artists").select("id,name,yt_channel_id,visibility,added_by").order("id").range(from, to)),
    pageAll<AlbumRow>((from, to) => T(sb, "albums").select("id,name,artist_id,release_date,yt_playlist_id,added_by").order("id").range(from, to)),
    pageAll<TrackRow>((from, to) => T(sb, "tracks").select("id,name,album_id,track_number,disc_number,duration_ms,created_at,visibility").order("id").range(from, to)),
    pageAll<VideoRow>((from, to) => T(sb, "track_videos").select("track_id,video_id,view_count,is_playable,is_primary").order("id").range(from, to)),
  ]);

  const artistById = new Map(artists.map((row) => [String(row.id), row]));
  const albumById = new Map(albums.map((row) => [String(row.id), row]));
  const videoByTrack = new Map<string, VideoRow>();
  for (const row of videos) {
    if (!row.video_id) continue;
    const key = String(row.track_id);
    const held = videoByTrack.get(key);
    videoByTrack.set(key, held ? betterVideo(held, row) : row);
  }

  const byTrackId = new Map<string, CatalogTrack>();
  const byName = new Map<string, CatalogTrack>();
  for (const row of tracks) {
    const album = row.album_id ? albumById.get(String(row.album_id)) : undefined;
    const artist = album?.artist_id ? artistById.get(String(album.artist_id)) : undefined;
    const video = videoByTrack.get(String(row.id));
    const entry: CatalogTrack = {
      id: String(row.id),
      name: String(row.name || ""),
      albumName: String(album?.name || ""),
      albumReleaseDate: album?.release_date ?? null,
      albumPlaylistId: album?.yt_playlist_id ?? null,
      artistId: album?.artist_id ? String(album.artist_id) : null,
      artistName: String(artist?.name || ""),
      artistChannelId: artist?.yt_channel_id ?? null,
      visibility: String(row.visibility || artist?.visibility || "public"),
      trackNumber: row.track_number ?? null,
      discNumber: row.disc_number ?? null,
      durationMs: row.duration_ms ?? null,
      createdAt: row.created_at ?? null,
      videoId: video?.video_id ?? null,
      videoViews: video?.view_count == null ? null : Number(video.view_count),
      videoPlayable: video?.is_playable ?? null,
    };
    byTrackId.set(entry.id, entry);
    // First writer wins: the catalogue holds re-uploads of the same song, and
    // a name lookup only ever needs one answer.
    const key = nameKey(entry.artistName, entry.name);
    if (key && entry.videoId && !byName.has(key)) byName.set(key, entry);
  }

  const ownedByArtist = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, owner: string | null, artistId: string | null) => {
    const key = String(owner || "").trim().toLowerCase();
    if (!key || !artistId) return;
    const set = map.get(key) || new Set<string>();
    set.add(String(artistId));
    map.set(key, set);
  };
  for (const row of artists) add(ownedByArtist, row.added_by, row.id);
  // An album imported into somebody else's artist still belongs to whoever
  // imported it, so it counts towards their music too.
  for (const row of albums) add(ownedByArtist, row.added_by, row.artist_id);

  const catalog: Catalog = {
    byTrackId,
    byName,
    artistIdsAddedBy: (email: string) => new Set(ownedByArtist.get(email.trim().toLowerCase()) || []),
  };
  cached = { at: Date.now(), catalog };
  return catalog;
}

/* ------------------------------------------------------------------ */
/* Background audio                                                   */
/* ------------------------------------------------------------------ */

/* Which songs would still sound with the screen off, FOR THIS PERSON. The two
   sources are the two /api/sj-bg-available answers the Background Play filter
   from: this account's own uploads, and tracks an artist has licensed for
   everybody. A flag read off track_audio alone would tell somebody a song
   plays in the background when the only upload is another account's. */
async function backgroundAudioTracks(sb: Sb, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const mine = await pageAll<{ track_id: string | null }>((from, to) => T(sb, "track_audio")
    .select("track_id")
    .eq("uploaded_by", userId)
    .order("id")
    .range(from, to));
  for (const row of mine) if (row.track_id) ids.add(String(row.track_id));
  for (const row of await approvedArtistAudioTracks(sb)) ids.add(String(row.track_id));
  return ids;
}

type Ctx = { filters: Prepared; background: Set<string> };

/* ------------------------------------------------------------------ */
/* Columns                                                            */
/* ------------------------------------------------------------------ */

export const COLUMNS: Record<Dataset, string[]> = {
  music: [
    "Artist", "Album", "Song", "Release Date", "Disc", "Track Number", "Duration",
    "Visibility", "Added To Jukebox", "Background Audio", "YouTube Video ID", "YouTube URL",
    "YouTube Views", "Playable On YouTube", "Artist YouTube Channel", "Album YouTube Playlist",
  ],
  playlists: [
    "Playlist", "Visibility", "Playlist Created", "Position", "Artist", "Album", "Song",
    "Duration", "Added To Playlist", "Added By", "Background Audio", "YouTube Video ID",
    "YouTube URL",
  ],
  songs: [
    "Song", "Artist", "Album", "Duration", "Added From", "Your Rating", "Has Lyrics",
    "Background Audio", "Added To Library", "YouTube Video ID", "YouTube URL", "YouTube Views",
  ],
  history: [
    "Played At (UTC)", "Played On", "Type", "Artist", "Song", "Album", "Listened",
    "Listened (ms)", "Skipped", "Rating At Play", "Background Audio", "YouTube Video ID",
    "YouTube URL", "Imported From",
  ],
};

export const DATASET_NOTE: Record<Dataset, string> = {
  music: "Every song under an artist or album you imported into the Jukebox catalogue.",
  playlists: "Every playlist you own, one row per song, in playing order.",
  songs: "Every song in your personal My Jukebox library, with your rating.",
  history: "Every play from the Jukebox, plus any Spotify or YouTube history you imported.",
};

function clock(ms: number | null | undefined) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const total = Math.round(value / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function yesNo(value: unknown) {
  return value === true ? "Yes" : value === false ? "No" : "";
}
function ratingLabel(rating: number | null | undefined) {
  const value = Number(rating);
  if (value === 2) return "Love";
  if (value === 1) return "Like";
  if (value === -1) return "Dislike";
  return "";
}

export type Cell = string | number | null;
export type Row = Cell[];

/* ------------------------------------------------------------------ */
/* The four datasets                                                  */
/* ------------------------------------------------------------------ */

async function* musicRows(sb: Sb, email: string, ctx: Ctx): AsyncGenerator<Row> {
  const catalog = await loadCatalog(sb);
  const owned = catalog.artistIdsAddedBy(email);
  if (!owned.size) return;
  const rows = [...catalog.byTrackId.values()].filter((track) => track.artistId && owned.has(track.artistId));
  rows.sort((a, b) =>
    a.artistName.localeCompare(b.artistName)
    || String(a.albumReleaseDate || "").localeCompare(String(b.albumReleaseDate || ""))
    || a.albumName.localeCompare(b.albumName)
    || (a.discNumber || 0) - (b.discNumber || 0)
    || (a.trackNumber || 0) - (b.trackNumber || 0)
    || a.name.localeCompare(b.name));
  for (const track of rows) {
    const background = ctx.background.has(track.id);
    if (!keepRow(ctx.filters, track.artistName, background)) continue;
    yield [
      track.artistName, track.albumName, track.name, track.albumReleaseDate || "",
      track.discNumber ?? "", track.trackNumber ?? "", clock(track.durationMs),
      track.visibility, track.createdAt || "", yesNo(background),
      track.videoId || "", watchUrl(track.videoId),
      track.videoViews ?? "", yesNo(track.videoPlayable),
      channelUrl(track.artistChannelId), listUrl(track.albumPlaylistId),
    ];
  }
}

type PlaylistRow = { id: string; name: string | null; visibility: string | null; is_public: boolean | null; created_at: string | null };
type PlaylistTrackRow = { playlist_id: string; track_id: string; position: number | null; added_at: string | null; added_by_name: string | null; added_by_email: string | null };

async function* playlistRows(sb: Sb, email: string, ctx: Ctx): AsyncGenerator<Row> {
  const playlists = await pageAll<PlaylistRow>((from, to) => T(sb, "playlists")
    .select("id,name,visibility,is_public,created_at")
    .ilike("user_email", likeSafe(email))
    .order("created_at", { ascending: true })
    .order("id")
    .range(from, to));
  if (!playlists.length) return;
  const catalog = await loadCatalog(sb);
  const items = await pageAll<PlaylistTrackRow>((from, to) => T(sb, "playlist_tracks")
    .select("playlist_id,track_id,position,added_at,added_by_name,added_by_email")
    .in("playlist_id", playlists.map((row) => String(row.id)))
    .order("playlist_id", { ascending: true })
    .order("position", { ascending: true })
    .order("id")
    .range(from, to));

  const byPlaylist = new Map<string, PlaylistTrackRow[]>();
  for (const item of items) {
    const key = String(item.playlist_id);
    const list = byPlaylist.get(key) || [];
    list.push(item);
    byPlaylist.set(key, list);
  }

  // A filter that can only be satisfied by a song is a filter an empty
  // playlist cannot pass, so its placeholder row goes with it.
  const songFilterOn = !!ctx.filters.artists || ctx.filters.background !== "any";

  for (const playlist of playlists) {
    if (ctx.filters.playlists && !ctx.filters.playlists.has(foldName(playlist.name))) continue;
    const visibility = String(playlist.visibility || (playlist.is_public ? "public" : "private"));
    const list = byPlaylist.get(String(playlist.id)) || [];
    // An empty playlist is still a playlist the person made; leaving it out of
    // their own export would quietly lose it.
    if (!list.length) {
      if (songFilterOn) continue;
      yield [playlist.name || "", visibility, playlist.created_at || "", "", "", "", "", "", "", "", "", "", ""];
      continue;
    }
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      const track = catalog.byTrackId.get(String(item.track_id));
      const background = ctx.background.has(String(item.track_id));
      if (!keepRow(ctx.filters, track?.artistName, background)) continue;
      yield [
        playlist.name || "", visibility, playlist.created_at || "", index + 1,
        track?.artistName || "", track?.albumName || "", track?.name || "",
        clock(track?.durationMs), item.added_at || "",
        item.added_by_name || item.added_by_email || "", yesNo(background),
        track?.videoId || "", watchUrl(track?.videoId),
      ];
    }
  }
}

type LibraryRow = {
  catalog_track_id: string | null; youtube_video_id: string | null; title: string | null;
  artist_name: string | null; album_name: string | null; duration_ms: number | null;
  source: string | null; youtube_view_count: number | null; lyrics: string | null; created_at: string | null;
};

async function* songRows(sb: Sb, email: string, ctx: Ctx): AsyncGenerator<Row> {
  const jukeboxes = await pageAll<{ id: string }>((from, to) => T(sb, "jukeboxes").select("id").ilike("owner_email", likeSafe(email)).order("id").range(from, to));
  if (!jukeboxes.length) return;
  const catalog = await loadCatalog(sb);
  const items = await pageAll<LibraryRow>((from, to) => T(sb, "my_jukebox_items")
    .select("catalog_track_id,youtube_video_id,title,artist_name,album_name,duration_ms,source,youtube_view_count,lyrics,created_at")
    .in("jukebox_id", jukeboxes.map((row) => String(row.id)))
    .order("created_at", { ascending: true })
    .order("id")
    .range(from, to));

  const ratings = await pageAll<{ track_id: string; new_rating: number | null }>((from, to) => T(sb, "rating_events")
    .select("track_id,new_rating,rated_at")
    .ilike("user_email", likeSafe(email))
    .order("rated_at", { ascending: false })
    .order("id")
    .range(from, to), 20_000);
  const ratingByTrack = new Map<string, number>();
  for (const row of ratings) {
    const key = String(row.track_id || "");
    if (key && !ratingByTrack.has(key)) ratingByTrack.set(key, Number(row.new_rating) || 0);
  }

  for (const item of items) {
    const track = item.catalog_track_id ? catalog.byTrackId.get(String(item.catalog_track_id)) : undefined;
    const videoId = item.youtube_video_id
      || track?.videoId
      || catalog.byName.get(nameKey(String(item.artist_name || ""), String(item.title || "")))?.videoId
      || null;
    const rating = item.catalog_track_id ? ratingByTrack.get(String(item.catalog_track_id)) : undefined;
    const background = !!item.catalog_track_id && ctx.background.has(String(item.catalog_track_id));
    if (!keepRow(ctx.filters, item.artist_name, background)) continue;
    yield [
      item.title || "", item.artist_name || "", item.album_name || "", clock(item.duration_ms),
      item.source || "", ratingLabel(rating), yesNo(!!item.lyrics), yesNo(background),
      item.created_at || "", videoId || "", watchUrl(videoId),
      item.youtube_view_count ?? track?.videoViews ?? "",
    ];
  }
}

type PlayRow = { track_id: string; played_at: string | null; duration_played_ms: number | null; rating_at_play: number | null; source: string | null };
type ImportedRow = {
  history_source: string | null; content_type: string | null; title: string | null; artist: string | null;
  album: string | null; played_at: string | null; duration_played_ms: number | null; skipped: boolean | null;
  youtube_video_id: string | null; youtube_url: string | null; source_file_name: string | null;
};

async function* historyRows(sb: Sb, email: string, userId: string, ctx: Ctx): AsyncGenerator<Row> {
  const catalog = await loadCatalog(sb);

  const plays = await pageAll<PlayRow>((from, to) => T(sb, "play_events")
    .select("track_id,played_at,duration_played_ms,rating_at_play,source")
    .ilike("user_email", likeSafe(email))
    .or("deleted.is.null,deleted.eq.false")
    .order("played_at", { ascending: false })
    .order("id")
    .range(from, to));

  for (const play of plays) {
    const track = catalog.byTrackId.get(String(play.track_id));
    const background = ctx.background.has(String(play.track_id));
    if (!keepRow(ctx.filters, track?.artistName, background)) continue;
    yield [
      play.played_at || "", "Suffering Jukebox", "Music",
      track?.artistName || "", track?.name || "", track?.albumName || "",
      clock(play.duration_played_ms), play.duration_played_ms ?? "", "",
      ratingLabel(play.rating_at_play), yesNo(background),
      track?.videoId || "", watchUrl(track?.videoId),
      play.source || "jukebox",
    ];
  }

  const imported = await pageAll<ImportedRow>((from, to) => T(sb, "spotify_history_events")
    .select("history_source,content_type,title,artist,album,played_at,duration_played_ms,skipped,youtube_video_id,youtube_url,source_file_name")
    .eq("user_id", userId)
    .or("deleted.is.null,deleted.eq.false")
    .order("played_at", { ascending: false })
    .order("id")
    .range(from, to));

  for (const event of imported) {
    // A YouTube import already carries its own watch URL. A Spotify row never
    // does, so the catalogue is asked whether we hold that song — an honest
    // blank when we do not, rather than a guessed search link. The lookup runs
    // either way now, because it is also the only thing that can say whether an
    // imported play is a song this account can hear with the screen off.
    const matched = catalog.byName.get(nameKey(String(event.artist || ""), String(event.title || "")));
    const videoId = event.youtube_video_id || matched?.videoId || null;
    const type = String(event.content_type || "music");
    const background = !!matched && ctx.background.has(matched.id);
    if (!keepRow(ctx.filters, event.artist, background)) continue;
    yield [
      event.played_at || "",
      event.history_source === "youtube" ? "YouTube" : "Spotify",
      type.charAt(0).toUpperCase() + type.slice(1),
      event.artist || "", event.title || "", event.album || "",
      clock(event.duration_played_ms), event.duration_played_ms ?? "",
      yesNo(!!event.skipped), "", yesNo(background),
      videoId || "", event.youtube_url || watchUrl(videoId),
      event.source_file_name || "",
    ];
  }
}

/* A delegating generator rather than a plain function, so the background-audio
   set can be read once, up front, without making the caller await before it has
   a stream to hand back. */
export async function* exportRows(
  sb: Sb,
  dataset: Dataset,
  user: { id: string; email: string },
  filters: ExportFilters = NO_FILTERS,
): AsyncGenerator<Row> {
  const email = user.email.toLowerCase();
  const ctx: Ctx = { filters: prepare(filters), background: await backgroundAudioTracks(sb, user.id) };
  if (dataset === "music") yield* musicRows(sb, email, ctx);
  else if (dataset === "playlists") yield* playlistRows(sb, email, ctx);
  else if (dataset === "songs") yield* songRows(sb, email, ctx);
  else yield* historyRows(sb, email, user.id, ctx);
}

/* ------------------------------------------------------------------ */
/* What there is to filter by                                         */
/* ------------------------------------------------------------------ */

/* The artist and playlist names to offer above the download buttons.
   Deliberately built from the three catalogue-backed sources and NOT from the
   listening history: a history is tens of thousands of rows and paging all of
   them to fill a dropdown would make opening the tab the slow part of the
   feature. An artist that only ever appears in an imported Spotify history can
   still be typed into the picker, which is why the artist filter matches on a
   folded name rather than on an id. */
export async function exportOptions(sb: Sb, user: { id: string; email: string }) {
  const email = user.email.toLowerCase();
  const catalog = await loadCatalog(sb);

  const artists = new Map<string, string>();
  const addArtist = (name: string | null | undefined) => {
    const label = String(name || "").trim();
    const key = foldName(label);
    if (key && !artists.has(key)) artists.set(key, label);
  };

  const owned = catalog.artistIdsAddedBy(email);
  for (const track of catalog.byTrackId.values()) {
    if (track.artistId && owned.has(track.artistId)) addArtist(track.artistName);
  }

  const playlists = await pageAll<PlaylistRow>((from, to) => T(sb, "playlists")
    .select("id,name,visibility,is_public,created_at")
    .ilike("user_email", likeSafe(email))
    .order("created_at", { ascending: true })
    .order("id")
    .range(from, to));

  if (playlists.length) {
    const items = await pageAll<PlaylistTrackRow>((from, to) => T(sb, "playlist_tracks")
      .select("playlist_id,track_id,position,added_at,added_by_name,added_by_email")
      .in("playlist_id", playlists.map((row) => String(row.id)))
      .order("playlist_id", { ascending: true })
      .order("position", { ascending: true })
      .order("id")
      .range(from, to));
    for (const item of items) addArtist(catalog.byTrackId.get(String(item.track_id))?.artistName);
  }

  const jukeboxes = await pageAll<{ id: string }>((from, to) => T(sb, "jukeboxes")
    .select("id").ilike("owner_email", likeSafe(email)).order("id").range(from, to));
  if (jukeboxes.length) {
    const library = await pageAll<{ artist_name: string | null }>((from, to) => T(sb, "my_jukebox_items")
      .select("artist_name,id")
      .in("jukebox_id", jukeboxes.map((row) => String(row.id)))
      .order("id")
      .range(from, to));
    for (const item of library) addArtist(item.artist_name);
  }

  const playlistNames: string[] = [];
  const seenPlaylist = new Set<string>();
  for (const row of playlists) {
    const label = String(row.name || "").trim();
    const key = foldName(label);
    if (!key || seenPlaylist.has(key)) continue;
    seenPlaylist.add(key);
    playlistNames.push(label);
  }

  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return {
    artists: [...artists.values()].sort((a, b) => collator.compare(a, b)),
    playlists: playlistNames.sort((a, b) => collator.compare(a, b)),
  };
}

/* ------------------------------------------------------------------ */
/* Serialising                                                        */
/* ------------------------------------------------------------------ */

// A leading =, +, - or @ makes a spreadsheet treat a song title as a formula.
// Prefixing an apostrophe is the standard defence and Excel hides it again.
function csvCell(value: Cell) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(row: Row) {
  return `${row.map(csvCell).join(",")}\r\n`;
}
