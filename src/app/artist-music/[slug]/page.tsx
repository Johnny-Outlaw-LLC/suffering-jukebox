import { notFound } from "next/navigation";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { approvedArtistAudioTracks } from "@/lib/bg-audio-eligibility";
import { ARTIST_AGREEMENT_VERSION } from "@/lib/artist-rights";
import CatalogPlayer from "./player";

export const dynamic = "force-dynamic";

export default async function ArtistMusicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) notFound();
  const sb = createSjServiceClient();
  const { data: artist, error: artistError } = await sb.schema(JUKEBOX_SCHEMA)
    .from("artists").select("id,name,slug,visibility")
    .eq("slug", slug).eq("visibility", "public").eq("artist_audio_visible", true).maybeSingle();
  if (artistError || !artist) notFound();
  const { data: albums, error: albumError } = await sb.schema(JUKEBOX_SCHEMA)
    .from("albums").select("id,name,release_date,art_url,artist_unreleased")
    .eq("artist_id", artist.id).eq("visibility", "public").eq("artist_audio_visible", true)
    .order("release_date", { ascending: true, nullsFirst: false });
  if (albumError) throw albumError;
  const albumIds = (albums ?? []).map((row) => row.id);
  const { data: tracks, error: trackError } = albumIds.length
    ? await sb.schema(JUKEBOX_SCHEMA).from("tracks")
        .select("id,album_id,name,disc_number,track_number,duration_ms,explicit,artist_audio_only")
        .in("album_id", albumIds).eq("visibility", "public").eq("artist_audio_visible", true)
    : { data: [], error: null };
  if (trackError) throw trackError;
  const trackIds = (tracks ?? []).map((row) => row.id);
  const { data: videos, error: videoError } = trackIds.length
    ? await sb.schema(JUKEBOX_SCHEMA).from("track_videos")
        .select("track_id,video_id,is_primary,is_playable,view_count")
        .in("track_id", trackIds).eq("is_playable", true)
    : { data: [], error: null };
  if (videoError) throw videoError;
  const licensed = new Set((await approvedArtistAudioTracks(
    sb, trackIds.filter((id) => tracks?.find((row) => row.id === id)?.artist_audio_only),
    ARTIST_AGREEMENT_VERSION,
  )).map((row) => row.track_id));
  const videoByTrack = new Map<string, string>();
  for (const video of [...(videos ?? [])].sort((a, b) =>
    Number(b.is_primary) - Number(a.is_primary) || Number(b.view_count ?? 0) - Number(a.view_count ?? 0))) {
    if (!videoByTrack.has(video.track_id)) videoByTrack.set(video.track_id, video.video_id);
  }
  const releaseList = (albums ?? []).map((album) => ({
    id: album.id,
    name: album.name,
    date: album.release_date,
    unreleased: album.artist_unreleased,
    art: album.art_url,
    tracks: (tracks ?? [])
      .filter((track) => track.album_id === album.id)
      .filter((track) => track.artist_audio_only ? licensed.has(track.id) : videoByTrack.has(track.id))
      .sort((a, b) => (a.disc_number ?? 1) - (b.disc_number ?? 1) || (a.track_number ?? 0) - (b.track_number ?? 0))
      .map((track) => ({
        id: track.id,
        name: track.name,
        disc: track.disc_number ?? 1,
        number: track.track_number ?? 0,
        durationMs: track.duration_ms,
        explicit: !!track.explicit,
        kind: track.artist_audio_only ? "audio" as const : "youtube" as const,
        videoId: track.artist_audio_only ? null : videoByTrack.get(track.id) ?? null,
      })),
  })).filter((album) => album.tracks.length);
  return <CatalogPlayer artist={{ name: artist.name, slug: artist.slug }} releases={releaseList} />;
}
