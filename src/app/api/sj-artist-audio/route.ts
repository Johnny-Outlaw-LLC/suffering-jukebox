import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { ARTIST_AGREEMENT_VERSION, isUuid } from "@/lib/artist-rights";
import { approvedArtistAudioTracks } from "@/lib/bg-audio-eligibility";
import { createB2DownloadUrl, sisterB2RedirectUrl } from "@/lib/b2-audio";

export const dynamic = "force-dynamic";
// New artist agreements also allow normal on-demand listening to original
// uploads with no YouTube video. Older agreements remain background-only.
const PUBLIC_SIGNED_URL_SECONDS = 6 * 60 * 60;

export async function GET(req: NextRequest) {
  const purpose = req.nextUrl.searchParams.get("purpose");
  if (purpose !== "mobile-background" && purpose !== "normal-playback") {
    return NextResponse.json(
      { ok: false, error: "Invalid audio purpose." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const requested = (req.nextUrl.searchParams.get("track_ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(isUuid)
    .slice(0, 50);
  const trackIds = [...new Set(requested)];
  const stream = req.nextUrl.searchParams.get("format") === "stream";
  if (stream && (purpose !== "normal-playback" || trackIds.length !== 1)) {
    return NextResponse.json({ ok: false, error: "Streaming requires one on-demand track." },
      { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!trackIds.length) {
    return NextResponse.json({ ok: true, tracks: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const sister = sisterB2RedirectUrl(req.nextUrl.host, req.nextUrl.pathname + req.nextUrl.search);
  if (sister) {
    return NextResponse.redirect(new URL(sister), {
      status: 307, headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  try {
    const sb = createSjServiceClient();
    let selected = await approvedArtistAudioTracks(
      sb, trackIds, purpose === "normal-playback" ? ARTIST_AGREEMENT_VERSION : undefined,
    );
    if (purpose === "normal-playback" && selected.length) {
      const { data: catalogTracks, error: trackError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("tracks").select("id,album_id,artist_audio_only,artist_audio_visible")
        .in("id", selected.map((row) => row.track_id));
      if (trackError) throw trackError;
      const permitted = (catalogTracks ?? []).filter((row) => row.artist_audio_only && row.artist_audio_visible);
      const { data: albums, error: albumError } = permitted.length
        ? await sb.schema(JUKEBOX_SCHEMA).from("albums")
            .select("id,artist_audio_visible").in("id", permitted.map((row) => row.album_id))
        : { data: [], error: null };
      if (albumError) throw albumError;
      const liveAlbums = new Set((albums ?? []).filter((row) => row.artist_audio_visible).map((row) => row.id));
      const liveTracks = new Set(permitted.filter((row) => liveAlbums.has(row.album_id)).map((row) => row.id));
      selected = selected.filter((row) => liveTracks.has(row.track_id));
    }
    if (!selected.length) {
      return NextResponse.json({ ok: true, tracks: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    const { data: audioRows, error: audioError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .select("id,storage_path,duration_seconds")
      .in("id", selected.map((row) => row.track_audio_id));
    if (audioError) throw audioError;
    const audioMap = new Map((audioRows ?? []).map((row) => [row.id, row]));
    const withAudio = selected.filter((row) => audioMap.get(row.track_audio_id)?.storage_path);
    const artistIds = [...new Set(withAudio.map((row) => row.artist_id))];
    const { data: artists } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id,name,slug")
      .in("id", artistIds);
    const artistMap = new Map((artists ?? []).map((artist) => [artist.id, artist]));
    const tracks = await Promise.all(withAudio.map(async (row) => {
      const audio = audioMap.get(row.track_audio_id)!;
      const url = await createB2DownloadUrl(audio.storage_path!, PUBLIC_SIGNED_URL_SECONDS);
      const artist = artistMap.get(row.artist_id);
      return {
        trackId: row.track_id,
        url,
        duration: audio.duration_seconds,
        artist: artist ? { name: artist.name, slug: artist.slug } : null,
        license: purpose === "normal-playback" ? "artist-approved-on-demand" : "artist-approved-mobile-background",
        expiresIn: PUBLIC_SIGNED_URL_SECONDS,
      };
    }));
    if (stream && tracks.length === 1) {
      return NextResponse.redirect(tracks[0].url, {
        status: 307, headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }
    return NextResponse.json(
      { ok: true, tracks },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[sj-artist-audio]", error);
    return NextResponse.json({ ok: false, error: "Could not authorize artist audio." }, { status: 500 });
  }
}
