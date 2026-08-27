// Persistent My Jukebox library access.  Unlike a live room, these records
// are permanent and are always read through server routes.
import { getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import {
  getOrCreateOwnerJukebox,
  sjb,
  type JukeboxRow,
  type ServiceClient,
  updateJukebox,
} from "@/lib/jukebox-db";
import type { NextRequest } from "next/server";

const T = (sb: ServiceClient, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

export type LibraryItem = {
  id: string;
  catalogTrackId: string | null;
  youtubeVideoId: string | null;
  title: string;
  artistName: string | null;
  albumName: string | null;
  albumArtUrl: string | null;
  durationMs: number | null;
  source: "catalog" | "youtube" | "spotify";
  sourceUri: string | null;
  youtubeViewCount: number | null;
  lyrics: string | null;
  lyricsSource: string | null;
  createdAt: string;
};

const ITEM_SELECT =
  "id,catalog_track_id,youtube_video_id,title,artist_name,album_name,album_art_url,duration_ms,source,source_uri,youtube_view_count,lyrics,lyrics_source,created_at";

const shapeItem = (row: any): LibraryItem => ({
  id: row.id,
  catalogTrackId: row.catalog_track_id ?? null,
  youtubeVideoId: row.youtube_video_id ?? null,
  title: row.title,
  artistName: row.artist_name ?? null,
  albumName: row.album_name ?? null,
  albumArtUrl: row.album_art_url ?? null,
  durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
  source: row.source,
  sourceUri: row.source_uri ?? null,
  youtubeViewCount: row.youtube_view_count == null ? null : Number(row.youtube_view_count),
  lyrics: row.lyrics ?? null,
  lyricsSource: row.lyrics_source ?? null,
  createdAt: row.created_at,
});


export async function ownerMyJukebox(req: NextRequest): Promise<
  | { user: { id: string; email: string }; sb: ServiceClient; jukebox: JukeboxRow }
  | null
> {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) return null;
  const sb = sjb();
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    null;
  const jukebox = await getOrCreateOwnerJukebox(sb, user.email, displayName);
  return { user: { id: user.id, email: user.email }, sb, jukebox };
}

export async function loadLibrary(sb: ServiceClient, jukeboxId: string): Promise<LibraryItem[]> {
  const { data, error } = await T(sb, "my_jukebox_items")
    .select(ITEM_SELECT)
    .eq("jukebox_id", jukeboxId)
    .order("created_at", { ascending: false })
    .limit(3000);
  if (error) throw error;
  return (data ?? []).map(shapeItem);
}

type CatalogRow = {
  id: string;
  name: string;
  duration_ms: number | null;
  albums: { name: string; art_url: string | null; artists: { name: string } | null } | null;
};

async function catalogRows(sb: ServiceClient, field: "track" | "album" | "artist", id: string) {
  let q = T(sb, "tracks")
    .select("id,name,duration_ms,albums!inner(name,art_url,artist_id,artists!inner(name))")
    .limit(1200);
  if (field === "track") q = q.eq("id", id);
  if (field === "album") q = q.eq("album_id", id);
  if (field === "artist") q = q.eq("albums.artist_id", id);
  const { data, error } = await q;
  if (error) throw error;
  // Supabase's generated relationship type models these many-to-one embeds as
  // arrays, while PostgREST returns one object for this select shape.
  return (data ?? []) as unknown as CatalogRow[];
}

/** Adds a global Catalog track, album, or artist without making the request fragile to a retry. */
export async function addCatalogItems(
  sb: ServiceClient,
  jukeboxId: string,
  field: "track" | "album" | "artist",
  id: string,
): Promise<{ added: number; skipped: number }> {
  const rows = await catalogRows(sb, field, id);
  if (!rows.length) return { added: 0, skipped: 0 };

  const ids = rows.map((r) => r.id);
  const { data: existing, error: existingError } = await T(sb, "my_jukebox_items")
    .select("catalog_track_id")
    .eq("jukebox_id", jukeboxId)
    .in("catalog_track_id", ids);
  if (existingError) throw existingError;
  const known = new Set((existing ?? []).map((r: any) => r.catalog_track_id));
  const fresh = rows.filter((r) => !known.has(r.id));
  if (!fresh.length) return { added: 0, skipped: rows.length };

  // Catalog tracks inherit the lyrics already stored by Suffering Jukebox.
  // A manual YouTube import never pretends it found lyrics when it did not.
  const { data: lyricRows, error: lyricError } = await T(sb, "lyrics")
    .select("track_id,lyrics,lyrics_source")
    .in("track_id", fresh.map((r) => r.id));
  if (lyricError) throw lyricError;
  const lyrics = new Map((lyricRows ?? []).map((r: any) => [r.track_id, r]));

  const { error } = await T(sb, "my_jukebox_items").insert(
    fresh.map((r) => ({
      ...(function () {
        const lyric: any = lyrics.get(r.id);
        return {
          lyrics: lyric?.lyrics ?? null,
          lyrics_source: lyric?.lyrics_source ?? null,
          lyrics_checked_at: new Date().toISOString(),
        };
      })(),
      jukebox_id: jukeboxId,
      catalog_track_id: r.id,
      title: r.name,
      artist_name: r.albums?.artists?.name ?? null,
      album_name: r.albums?.name ?? null,
      album_art_url: r.albums?.art_url ?? null,
      duration_ms: r.duration_ms,
      source: "catalog",
    })),
  );
  if (error) throw error;
  return { added: fresh.length, skipped: rows.length - fresh.length };
}

export async function addYouTubeItem(
  sb: ServiceClient,
  jukeboxId: string,
  input: {
    videoId: string;
    title: string;
    artistName?: string | null;
    albumName?: string | null;
    thumbnail?: string | null;
    durationMs?: number | null;
    views?: number | null;
    source?: "youtube" | "spotify";
    sourceUri?: string | null;
    lyrics?: string | null;
    lyricsSource?: string | null;
  },
) {
  const { data: existing, error: existingError } = await T(sb, "my_jukebox_items")
    .select("id")
    .eq("jukebox_id", jukeboxId)
    .eq("youtube_video_id", input.videoId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { item: null, duplicate: true };
  const now = new Date().toISOString();
  const { data, error } = await T(sb, "my_jukebox_items")
    .insert({
      jukebox_id: jukeboxId,
      youtube_video_id: input.videoId,
      title: cleanText(input.title, 180) || "Untitled YouTube track",
      artist_name: cleanText(input.artistName, 160),
      album_name: cleanText(input.albumName, 160),
      album_art_url: cleanUrl(input.thumbnail),
      duration_ms: finiteInt(input.durationMs),
      source: input.source ?? "youtube",
      source_uri: cleanUrl(input.sourceUri),
      youtube_view_count: finiteInt(input.views),
      youtube_stats_at: now,
      lyrics: cleanText(input.lyrics, 30_000),
      lyrics_source: cleanText(input.lyricsSource, 100),
      lyrics_checked_at: now,
    })
    .select(ITEM_SELECT)
    .single();
  if (error) throw error;
  return { item: shapeItem(data), duplicate: false };
}

export async function removeLibraryItems(
  sb: ServiceClient,
  jukeboxId: string,
  filter: { itemId?: string; artistName?: string; albumName?: string },
): Promise<number> {
  let q = T(sb, "my_jukebox_items").delete().eq("jukebox_id", jukeboxId).select("id");
  if (filter.itemId) q = q.eq("id", filter.itemId);
  else if (filter.artistName) q = q.ilike("artist_name", filter.artistName);
  else if (filter.albumName) q = q.ilike("album_name", filter.albumName);
  else return 0;
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).length;
}


export async function logMyJukeboxPlay(
  sb: ServiceClient,
  jukeboxId: string,
  itemId: string,
  userId: string | null,
) {
  const { error } = await T(sb, "my_jukebox_plays").insert({
    jukebox_id: jukeboxId,
    library_item_id: itemId,
    played_by_user: userId,
  });
  if (error) throw error;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

function finiteInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), Number.MAX_SAFE_INTEGER) : null;
}
