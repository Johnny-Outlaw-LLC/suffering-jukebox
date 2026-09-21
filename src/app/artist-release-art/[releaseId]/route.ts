import { NextRequest, NextResponse } from "next/server";
import { ARTIST_AGREEMENT_VERSION, isUuid } from "@/lib/artist-rights";
import { approvedArtistAudioTracks } from "@/lib/bg-audio-eligibility";
import { createB2DownloadUrl, sisterB2RedirectUrl } from "@/lib/b2-audio";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ releaseId: string }> }) {
  const { releaseId } = await params;
  if (!isUuid(releaseId)) return new NextResponse(null, { status: 404 });
  const sister = sisterB2RedirectUrl(req.nextUrl.host, `/artist-release-art/${releaseId}`);
  if (sister) {
    return NextResponse.redirect(sister, {
      status: 307, headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  try {
    const sb = createSjServiceClient();
    const { data: release, error } = await sb.schema(JUKEBOX_SCHEMA)
      .from("artist_upload_releases")
      .select("artist_id,art_storage_path,published_album_id")
      .eq("id", releaseId).maybeSingle();
    if (error || !release?.art_storage_path || !release.published_album_id) return new NextResponse(null, { status: 404 });
    const [{ data: album }, { data: artist }, { data: drafts }] = await Promise.all([
      sb.schema(JUKEBOX_SCHEMA).from("albums").select("artist_audio_visible")
        .eq("id", release.published_album_id).maybeSingle(),
      sb.schema(JUKEBOX_SCHEMA).from("artists").select("visibility,artist_audio_visible")
        .eq("id", release.artist_id).maybeSingle(),
      sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks").select("id").eq("release_id", releaseId),
    ]);
    if (!album?.artist_audio_visible || artist?.visibility !== "public" || !artist.artist_audio_visible) {
      return new NextResponse(null, { status: 404 });
    }
    const licensed = await approvedArtistAudioTracks(sb, (drafts ?? []).map((row) => row.id), ARTIST_AGREEMENT_VERSION);
    if (!licensed.length) return new NextResponse(null, { status: 404 });
    return NextResponse.redirect(await createB2DownloadUrl(release.art_storage_path, 60 * 60), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[artist-release-art]", error);
    return new NextResponse(null, { status: 500 });
  }
}
