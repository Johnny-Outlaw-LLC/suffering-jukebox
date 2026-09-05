import type { SupabaseClient } from "@supabase/supabase-js";
import { JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

/// Which tracks an artist has licensed for mobile background play.
///
/// Two callers need this and they must never disagree: /api/sj-artist-audio
/// signs a URL for a track, and /api/sj-bg-available answers the Background
/// Play filter. A filter offering a song the player then refuses to play is
/// worse than no filter, so the rule lives here once rather than in both.
///
/// Approval is two-sided on purpose: the track is approved (artist_catalog_tracks)
/// AND the agreement it arrived under is still approved (artist_rights_agreements).
/// A withdrawn agreement therefore revokes every track under it without anyone
/// having to walk the catalogue.
export type EligibleArtistAudio = {
  track_id: string;
  track_audio_id: string;
  artist_id: string;
};

export async function approvedArtistAudioTracks(
  sb: SupabaseClient,
  trackIds?: string[],
): Promise<EligibleArtistAudio[]> {
  // An explicit empty list means "these zero tracks", not "the whole catalogue".
  if (trackIds && !trackIds.length) return [];

  let q = sb
    .schema(JUKEBOX_SCHEMA)
    .from("artist_catalog_tracks")
    .select("agreement_id,track_audio_id,track_id,artist_id,approved_at")
    .eq("status", "approved")
    .order("approved_at", { ascending: false });
  if (trackIds) q = q.in("track_id", trackIds);

  const { data: candidates, error } = await q;
  if (error) throw error;
  if (!candidates?.length) return [];

  const { data: agreements, error: agreementError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artist_rights_agreements")
    .select("id")
    .in("id", [...new Set(candidates.map((row) => row.agreement_id))])
    .eq("status", "approved");
  if (agreementError) throw agreementError;
  const live = new Set((agreements ?? []).map((row) => row.id));

  // Newest approval wins per track - the order above is what makes this a
  // "most recent" pick rather than an arbitrary one.
  const chosen = new Map<string, EligibleArtistAudio>();
  for (const row of candidates) {
    if (!live.has(row.agreement_id) || chosen.has(row.track_id)) continue;
    chosen.set(row.track_id, {
      track_id: row.track_id,
      track_audio_id: row.track_audio_id,
      artist_id: row.artist_id,
    });
  }
  return [...chosen.values()];
}
