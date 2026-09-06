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
/* Columns                                                            */
/* ------------------------------------------------------------------ */

export const COLUMNS: Record<Dataset, string[]> = {
  music: [
    "Artist", "Album", "Song", "Release Date", "Disc", "Track Number", "Duration",
    "Visibility", "Added To Jukebox", "YouTube Video ID", "YouTube URL", "YouTube Views",
    "Playable On YouTube", "Artist YouTube Channel", "Album YouTube Playlist",
  ],
  playlists: [
    "Playlist", "Visibility", "Playlist Created", "Position", "Artist", "Album", "Song",
    "Duration", "Added To Playlist", "Added By", "YouTube Video ID", "YouTube URL",
  ],
  songs: [
    "Song", "Artist", "Album", "Duration", "Added From", "Your Rating", "Has Lyrics",
    "Added To Library", "YouTube Video ID", "YouTube URL", "YouTube Views",
  ],
  history: [
    "Played At (UTC)", "Played On", "Type", "Artist", "Song", "Album", "Listened",
    "Listened (ms)", "Skipped", "Rating At Play", "YouTube Video ID", "YouTube URL", "Imported From",
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

async function* musicRows(sb: Sb, email: string): AsyncGenerator<Row> {
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
    yield [
      track.artistName, track.albumName, track.name, track.albumReleaseDate || "",
      track.discNumber ?? "", track.trackNumber ?? "", clock(track.durationMs),
      track.visibility, track.createdAt || "", track.videoId || "", watchUrl(track.videoId),
      track.videoViews ?? "", yesNo(track.videoPlayable),
      channelUrl(track.artistChannelId), listUrl(track.albumPlaylistId),
    ];
  }
}

type PlaylistRow = { id: string; name: string | null; visibility: string | null; is_public: boolean | null; created_at: string | null };
type PlaylistTrackRow = { playlist_id: string; track_id: string; position: number | null; added_at: string | null; added_by_name: string | null; added_by_email: string | null };

async function* playlistRows(sb: Sb, email: string): AsyncGenerator<Row> {
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

  for (const playlist of playlists) {
    const visibility = String(playlist.visibility || (playlist.is_public ? "public" : "private"));
    const list = byPlaylist.get(String(playlist.id)) || [];
    // An empty playlist is still a playlist the person made; leaving it out of
    // their own export would quietly lose it.
    if (!list.length) {
      yield [playlist.name || "", visibility, playlist.created_at || "", "", "", "", "", "", "", "", "", ""];
      continue;
    }
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      const track = catalog.byTrackId.get(String(item.track_id));
      yield [
        playlist.name || "", visibility, playlist.created_at || "", index + 1,
        track?.artistName || "", track?.albumName || "", track?.name || "",
        clock(track?.durationMs), item.added_at || "",
        item.added_by_name || item.added_by_email || "",
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

async function* songRows(sb: Sb, email: string): AsyncGenerator<Row> {
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
    yield [
      item.title || "", item.artist_name || "", item.album_name || "", clock(item.duration_ms),
      item.source || "", ratingLabel(rating), yesNo(!!item.lyrics), item.created_at || "",
      videoId || "", watchUrl(videoId), item.youtube_view_count ?? track?.videoViews ?? "",
    ];
  }
}

type PlayRow = { track_id: string; played_at: string | null; duration_played_ms: number | null; rating_at_play: number | null; source: string | null };
type ImportedRow = {
  history_source: string | null; content_type: string | null; title: string | null; artist: string | null;
  album: string | null; played_at: string | null; duration_played_ms: number | null; skipped: boolean | null;
  youtube_video_id: string | null; youtube_url: string | null; source_file_name: string | null;
};

async function* historyRows(sb: Sb, email: string, userId: string): AsyncGenerator<Row> {
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
    yield [
      play.played_at || "", "Suffering Jukebox", "Music",
      track?.artistName || "", track?.name || "", track?.albumName || "",
      clock(play.duration_played_ms), play.duration_played_ms ?? "", "",
      ratingLabel(play.rating_at_play),
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
    // blank when we do not, rather than a guessed search link.
    const matched = event.youtube_video_id
      ? undefined
      : catalog.byName.get(nameKey(String(event.artist || ""), String(event.title || "")));
    const videoId = event.youtube_video_id || matched?.videoId || null;
    const type = String(event.content_type || "music");
    yield [
      event.played_at || "",
      event.history_source === "youtube" ? "YouTube" : "Spotify",
      type.charAt(0).toUpperCase() + type.slice(1),
      event.artist || "", event.title || "", event.album || "",
      clock(event.duration_played_ms), event.duration_played_ms ?? "",
      yesNo(!!event.skipped), "",
      videoId || "", event.youtube_url || watchUrl(videoId),
      event.source_file_name || "",
    ];
  }
}

export function exportRows(sb: Sb, dataset: Dataset, user: { id: string; email: string }): AsyncGenerator<Row> {
  const email = user.email.toLowerCase();
  if (dataset === "music") return musicRows(sb, email);
  if (dataset === "playlists") return playlistRows(sb, email);
  if (dataset === "songs") return songRows(sb, email);
  return historyRows(sb, email, user.id);
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
