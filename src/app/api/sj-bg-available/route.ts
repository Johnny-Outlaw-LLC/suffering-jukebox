import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { approvedArtistAudioTracks } from "@/lib/bg-audio-eligibility";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/// What the Background Play filter is allowed to show: track ids that will
/// still sound with the screen off, plus the artists they belong to. Ids only,
/// never signed URLs - the filter answers a checkbox, and minting a playable
/// link per track to do that would be slow and would hand out audio nobody
/// asked to play. /api/sj-artist-audio still does the signing, a screen at a time.
///
/// The artist rollup has to happen here rather than in the page: the landing
/// grid only holds per-artist summary rows, and `tracks` fills in one artist at
/// a time as they are opened, so a client-side rollup would report zero for
/// every artist nobody had visited yet and the filter would empty the grid.
///
/// Two sources, matching what loadTrackAudio would actually hand the player:
///  - the caller's own uploads, scoped to their user id exactly as the RLS
///    policy on jukebox.track_audio would (service role is used only to do the
///    joins in one round trip, never to widen who can see what)
///  - artist-licensed tracks, identical for everyone
const CHUNK = 200;

async function artistIdsForTracks(
  sb: ReturnType<typeof createSjServiceClient>,
  trackIds: string[],
): Promise<string[]> {
  if (!trackIds.length) return [];
  const albumIds = new Set<string>();
  for (let i = 0; i < trackIds.length; i += CHUNK) {
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("tracks")
      .select("album_id")
      .in("id", trackIds.slice(i, i + CHUNK));
    if (error) throw error;
    (data ?? []).forEach((row) => row.album_id && albumIds.add(row.album_id));
  }
  const ids = [...albumIds];
  const artistIds = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .select("artist_id")
      .in("id", ids.slice(i, i + CHUNK));
    if (error) throw error;
    (data ?? []).forEach((row) => row.artist_id && artistIds.add(row.artist_id));
  }
  return [...artistIds];
}

export async function GET(req: NextRequest) {
  try {
    const sb = createSjServiceClient();
    const user = await getAuthUser(req).catch(() => null);

    const trackIds = new Set<string>();
    if (user) {
      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("track_audio")
        .select("track_id")
        .eq("uploaded_by", user.id);
      if (error) throw error;
      (data ?? []).forEach((row) => row.track_id && trackIds.add(row.track_id));
    }
    (await approvedArtistAudioTracks(sb)).forEach((row) => trackIds.add(row.track_id));

    const ids = [...trackIds];
    return NextResponse.json(
      { ok: true, trackIds: ids, artistIds: await artistIdsForTracks(sb, ids) },
      // Personal to the caller once they are signed in, so never shared.
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[sj-bg-available]", error);
    return NextResponse.json({ ok: false, error: "Could not load background audio." }, { status: 500 });
  }
}
