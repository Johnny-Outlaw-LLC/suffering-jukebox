import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { isUuid } from "@/lib/artist-rights";

export const dynamic = "force-dynamic";
// Approved artist audio is intentionally public, but the bucket remains private.
// A six-hour URL prevents longer discovery queues from expiring mid-session.
const PUBLIC_SIGNED_URL_SECONDS = 6 * 60 * 60;

export async function GET(req: NextRequest) {
  const requested = (req.nextUrl.searchParams.get("track_ids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(isUuid)
    .slice(0, 50);
  const trackIds = [...new Set(requested)];
  if (!trackIds.length) {
    return NextResponse.json({ ok: true, tracks: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const sb = createSjServiceClient();
    const { data: candidates, error: candidateError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_catalog_tracks")
      .select("id,agreement_id,track_audio_id,track_id,artist_id,approved_at")
      .in("track_id", trackIds)
      .eq("status", "approved")
      .order("approved_at", { ascending: false });
    if (candidateError) throw candidateError;
    if (!candidates?.length) {
      return NextResponse.json({ ok: true, tracks: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    const agreementIds = [...new Set(candidates.map((row) => row.agreement_id))];
    const { data: agreements, error: agreementError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .select("id,artist_id,status")
      .in("id", agreementIds)
      .eq("status", "approved");
    if (agreementError) throw agreementError;
    const approvedAgreements = new Set((agreements ?? []).map((row) => row.id));
    const eligible = candidates.filter((row) => approvedAgreements.has(row.agreement_id));
    const chosen = new Map<string, (typeof eligible)[number]>();
    for (const row of eligible) if (!chosen.has(row.track_id)) chosen.set(row.track_id, row);
    if (!chosen.size) {
      return NextResponse.json({ ok: true, tracks: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    const selected = [...chosen.values()];
    const { data: audioRows, error: audioError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .select("id,storage_path,duration_seconds")
      .in("id", selected.map((row) => row.track_audio_id));
    if (audioError) throw audioError;
    const audioMap = new Map((audioRows ?? []).map((row) => [row.id, row]));
    const withAudio = selected.filter((row) => audioMap.get(row.track_audio_id)?.storage_path);
    const paths = withAudio.map((row) => audioMap.get(row.track_audio_id)!.storage_path);
    const { data: signed, error: signedError } = await sb.storage
      .from("jukebox-audio")
      .createSignedUrls(paths, PUBLIC_SIGNED_URL_SECONDS);
    if (signedError) throw signedError;

    const artistIds = [...new Set(withAudio.map((row) => row.artist_id))];
    const { data: artists } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id,name,slug")
      .in("id", artistIds);
    const artistMap = new Map((artists ?? []).map((artist) => [artist.id, artist]));
    const signedByPath = new Map(
      (signed ?? []).filter((row) => row.signedUrl).map((row) => [row.path, row.signedUrl]),
    );
    const tracks = withAudio.flatMap((row) => {
      const audio = audioMap.get(row.track_audio_id)!;
      const url = signedByPath.get(audio.storage_path);
      if (!url) return [];
      const artist = artistMap.get(row.artist_id);
      return [{
        trackId: row.track_id,
        url,
        duration: audio.duration_seconds,
        artist: artist ? { name: artist.name, slug: artist.slug } : null,
        license: "artist-approved",
        expiresIn: PUBLIC_SIGNED_URL_SECONDS,
      }];
    });
    return NextResponse.json(
      { ok: true, tracks },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[sj-artist-audio]", error);
    return NextResponse.json({ ok: false, error: "Could not authorize artist audio." }, { status: 500 });
  }
}
