import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

type ServiceClient = ReturnType<typeof createSjServiceClient>;

async function selectInChunks(
  sb: ServiceClient,
  table: string,
  select: string,
  column: string,
  values: string[],
) {
  const rows: any[] = [];
  const unique = [...new Set(values.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from(table)
      .select(select)
      .in(column, unique.slice(i, i + 100));
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

export async function loadUserArtistCatalog(sb: ServiceClient, userId: string) {
  const { data: audio, error: audioError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_audio")
    .select("id,track_id,storage_path,duration_seconds,file_bytes,created_at")
    .eq("uploaded_by", userId)
    .order("created_at", { ascending: true });
  if (audioError) throw audioError;
  if (!audio?.length) return [];

  const tracks = await selectInChunks(
    sb,
    "tracks",
    "id,name,album_id,track_number,duration_ms,explicit",
    "id",
    audio.map((row) => row.track_id),
  );
  const trackMap = new Map(tracks.map((row) => [row.id, row]));
  const albums = await selectInChunks(
    sb,
    "albums",
    "id,name,artist_id,release_date,art_url",
    "id",
    tracks.map((row) => row.album_id),
  );
  const albumMap = new Map(albums.map((row) => [row.id, row]));
  const artists = await selectInChunks(
    sb,
    "artists",
    "id,name,slug,is_community",
    "id",
    albums.map((row) => row.artist_id),
  );
  const artistMap = new Map(artists.map((row) => [row.id, row]));
  const grouped = new Map<string, any>();

  for (const file of audio) {
    const track = trackMap.get(file.track_id);
    const album = track ? albumMap.get(track.album_id) : null;
    const artist = album ? artistMap.get(album.artist_id) : null;
    if (!track || !album || !artist) continue;
    if (!grouped.has(artist.id)) {
      grouped.set(artist.id, {
        artist: {
          id: artist.id,
          name: artist.name,
          slug: artist.slug,
          isCommunity: artist.is_community,
        },
        tracks: [],
      });
    }
    grouped.get(artist.id).tracks.push({
      trackAudioId: file.id,
      trackId: file.track_id,
      trackName: track.name,
      trackNumber: track.track_number,
      durationMs: track.duration_ms,
      fileBytes: file.file_bytes,
      albumId: album.id,
      albumName: album.name,
      releaseDate: album.release_date,
    });
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      trackCount: group.tracks.length,
      fileBytes: group.tracks.reduce(
        (total: number, track: any) => total + (Number(track.fileBytes) || 0),
        0,
      ),
    }))
    .sort((a, b) => a.artist.name.localeCompare(b.artist.name));
}

