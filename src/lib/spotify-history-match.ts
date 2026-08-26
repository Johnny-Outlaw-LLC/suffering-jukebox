// Resolve Spotify (title, artist) pairs to catalogue track ids for history import.

import { JUKEBOX_SCHEMA, type createSjServiceClient } from "@/lib/sj-admin-auth";
import { artistMatches, normTitle, titleMatches } from "@/lib/catalog-index";

type Sb = ReturnType<typeof createSjServiceClient>;
const T = (sb: Sb, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

export type CatalogHit = {
  trackId: string;
  artistId: string;
  albumId: string;
  title: string;
  artist: string;
  album: string;
};

type IndexEntry = { normTitle: string; hit: CatalogHit };

const PAGE = 1000;
let cached: { at: number; byArtist: Map<string, IndexEntry[]> } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function loadResolveIndex(sb: Sb, userEmail: string): Promise<Map<string, IndexEntry[]>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.byArtist;

  const byArtist = new Map<string, IndexEntry[]>();
  const add = (hit: CatalogHit) => {
    const a = normTitle(hit.artist);
    const t = normTitle(hit.title);
    if (!a || !t) return;
    const list = byArtist.get(a) || [];
    list.push({ normTitle: t, hit });
    byArtist.set(a, list);
  };

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await T(sb, "tracks")
      .select("id,name,album_id,albums!inner(id,name,artist_id,visibility,artists!inner(id,name,visibility))")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    for (const row of rows) {
      const vis = row.albums?.artists?.visibility ?? "public";
      if (vis !== "public") continue;
      add({
        trackId: String(row.id),
        artistId: String(row.albums?.artists?.id || row.albums?.artist_id || ""),
        albumId: String(row.album_id || row.albums?.id || ""),
        title: row.name || "",
        artist: row.albums?.artists?.name || "",
        album: row.albums?.name || "",
      });
    }
    if (rows.length < PAGE) break;
  }

  if (userEmail) {
    const { data: access } = await T(sb, "content_access").select("artist_id").eq("user_email", userEmail);
    const artistIds = (access ?? []).map((r: any) => r.artist_id).filter(Boolean);
    if (artistIds.length) {
      const { data } = await T(sb, "tracks")
        .select("id,name,album_id,albums!inner(id,name,artist_id,artists!inner(id,name))")
        .in("albums.artist_id", artistIds)
        .limit(5000);
      for (const row of (data ?? []) as any[]) {
        add({
          trackId: String(row.id),
          artistId: String(row.albums?.artists?.id || row.albums?.artist_id || ""),
          albumId: String(row.album_id || row.albums?.id || ""),
          title: row.name || "",
          artist: row.albums?.artists?.name || "",
          album: row.albums?.name || "",
        });
      }
    }
  }

  cached = { at: Date.now(), byArtist };
  return byArtist;
}

export function invalidateResolveIndex() {
  cached = null;
}

function findHit(byArtist: Map<string, IndexEntry[]>, title: string, artist: string): CatalogHit | null {
  const t = normTitle(title);
  const a = normTitle(artist);
  if (!t || !a) return null;
  for (const [knownArtist, entries] of byArtist) {
    if (!artistMatches(knownArtist, a)) continue;
    for (const entry of entries) {
      if (entry.normTitle === t || titleMatches(t, entry.normTitle)) return entry.hit;
    }
  }
  return null;
}

export async function resolveSpotifyTracks(
  sb: Sb,
  userEmail: string,
  tracks: Array<{ title?: string; artist?: string; uri?: string; n?: number }>,
) {
  const byArtist = await loadResolveIndex(sb, userEmail);
  return tracks.map((track, i) => {
    const hit = findHit(byArtist, track.title || "", track.artist || "");
    return {
      n: track.n ?? i,
      uri: track.uri || null,
      title: track.title || "",
      artist: track.artist || "",
      matched: !!hit,
      trackId: hit?.trackId || null,
      artistId: hit?.artistId || null,
      albumId: hit?.albumId || null,
      catalogTitle: hit?.title || null,
      catalogArtist: hit?.artist || null,
      catalogAlbum: hit?.album || null,
    };
  });
}

