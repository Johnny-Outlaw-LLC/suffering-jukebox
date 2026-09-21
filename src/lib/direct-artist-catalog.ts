import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { createB2DownloadUrl, putB2Object } from "@/lib/b2-audio";

type Client = ReturnType<typeof createSjServiceClient>;
const T = (sb: Client, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

type DraftTrack = {
  id: string;
  release_id: string;
  user_id: string;
  name: string;
  disc_number: number;
  track_number: number;
  duration_ms: number | null;
  explicit: boolean;
};

async function draftsForAgreement(sb: Client, agreementId: string) {
  const { data: rights, error: rightsError } = await T(sb, "artist_catalog_tracks")
    .select("track_id,track_audio_id,user_id,artist_id")
    .eq("agreement_id", agreementId);
  if (rightsError) throw rightsError;
  const ids = (rights ?? []).map((row) => row.track_id);
  if (!ids.length) return { drafts: [] as DraftTrack[], releases: [] as any[] };
  const { data: drafts, error: draftError } = await T(sb, "artist_upload_tracks")
    .select("id,release_id,user_id,name,disc_number,track_number,duration_ms,explicit")
    .in("id", ids);
  if (draftError) throw draftError;
  if (!drafts?.length) return { drafts: [] as DraftTrack[], releases: [] as any[] };
  const { data: releases, error: releaseError } = await T(sb, "artist_upload_releases")
    .select("id,user_id,artist_id,name,release_date,is_unreleased,art_url,art_storage_path,published_album_id")
    .in("id", [...new Set(drafts.map((row) => row.release_id))]);
  if (releaseError) throw releaseError;
  const rightById = new Map((rights ?? []).map((row) => [row.track_id, row]));
  const releaseById = new Map((releases ?? []).map((row) => [row.id, row]));
  const { data: audio, error: audioError } = await T(sb, "track_audio")
    .select("id,track_id,uploaded_by,storage_path")
    .in("track_id", drafts.map((row) => row.id));
  if (audioError) throw audioError;
  const audioById = new Map((audio ?? []).map((row) => [row.id, row]));
  for (const draft of drafts) {
    const right = rightById.get(draft.id);
    const release = releaseById.get(draft.release_id);
    const file = right ? audioById.get(right.track_audio_id) : null;
    if (!right || !release || !file || !file.storage_path ||
        right.user_id !== draft.user_id || right.user_id !== release.user_id ||
        right.artist_id !== release.artist_id || file.uploaded_by !== draft.user_id ||
        file.track_id !== draft.id) {
      throw new Error("The submitted release no longer matches its uploaded audio.");
    }
  }
  return { drafts: drafts as DraftTrack[], releases: releases ?? [] };
}

async function catalogCoverUrl(release: { id: string; art_url?: string | null; art_storage_path?: string | null }, albumId: string) {
  if (release.art_storage_path) {
    try {
      const signed = await createB2DownloadUrl(release.art_storage_path, 60);
      const upstream = await fetch(signed, { signal: AbortSignal.timeout(20000) });
      if (upstream.ok) {
        await putB2Object(`album-art/${albumId}.jpg`, Buffer.from(await upstream.arrayBuffer()), "image/jpeg");
        return `/album-art/${albumId}`;
      }
    } catch (error) {
      console.error("[direct-artist-catalog] cover copy", error);
    }
  }
  return release.art_url || null;
}

/** Prepare hidden catalog rows before the rights decision changes to approved. */
export async function prepareDirectArtistCatalog(sb: Client, agreementId: string, uploaderEmail: string) {
  const { drafts, releases } = await draftsForAgreement(sb, agreementId);
  for (const release of releases) {
    let albumId = release.published_album_id as string | null;
    if (!albumId) {
      const { data: album, error } = await T(sb, "albums")
        .insert({ artist_id: release.artist_id, name: release.name,
          release_date: release.is_unreleased ? null : release.release_date,
          art_url: release.art_url, added_by: uploaderEmail, visibility: "public",
          artist_unreleased: release.is_unreleased,
          artist_audio_visible: false })
        .select("id").single();
      if (error) throw error;
      albumId = album.id;
      const { error: saveError } = await T(sb, "artist_upload_releases")
        .update({ published_album_id: albumId }).eq("id", release.id).eq("user_id", release.user_id);
      if (saveError) throw saveError;
    }
    if (!albumId) throw new Error("The submitted release has no catalog album.");
    const artUrl = await catalogCoverUrl(release, albumId);
    if (artUrl && artUrl !== release.art_url) {
      const { error: artError } = await T(sb, "albums").update({ art_url: artUrl }).eq("id", albumId);
      if (artError) throw artError;
    }
    for (const draft of drafts.filter((row) => row.release_id === release.id)) {
      const { data: existing, error: existingError } = await T(sb, "tracks")
        .select("id,album_id,artist_audio_only").eq("id", draft.id).maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        if (existing.album_id !== albumId || !existing.artist_audio_only) {
          throw new Error("A submitted track conflicts with the catalog.");
        }
        continue;
      }
      const { error } = await T(sb, "tracks").insert({
        id: draft.id, album_id: albumId, name: draft.name,
        disc_number: draft.disc_number, track_number: draft.track_number,
        duration_ms: draft.duration_ms, explicit: draft.explicit,
        yt_snapshot_enabled: false, visibility: "public",
        artist_audio_only: true, artist_audio_visible: false,
      });
      if (error) throw error;
    }
  }
}

/** The album is hidden first during revocation and shown last on approval. */
export async function setDirectArtistCatalogVisible(sb: Client, agreementId: string, visible: boolean) {
  const { drafts, releases } = await draftsForAgreement(sb, agreementId);
  const ids = drafts.map((row) => row.id);
  const albumIds = releases.map((row) => row.published_album_id).filter(Boolean) as string[];
  const artistIds = [...new Set(releases.map((row) => row.artist_id))];
  if (!visible && albumIds.length) {
    const { error } = await T(sb, "albums").update({ artist_audio_visible: false }).in("id", albumIds);
    if (error) throw error;
  }
  if (ids.length) {
    const { error } = await T(sb, "tracks").update({ artist_audio_visible: visible }).in("id", ids);
    if (error) throw error;
  }
  if (visible && albumIds.length) {
    const { error } = await T(sb, "albums").update({ artist_audio_visible: true }).in("id", albumIds);
    if (error) throw error;
  }
  for (const artistId of artistIds) {
    const { data: artist, error: artistError } = await T(sb, "artists")
      .select("artist_upload_created_by").eq("id", artistId).maybeSingle();
    if (artistError) throw artistError;
    if (!artist?.artist_upload_created_by) continue;
    if (visible) {
      const { error } = await T(sb, "artists").update({ visibility: "public", artist_audio_visible: true }).eq("id", artistId);
      if (error) throw error;
    } else {
      const { count, error: countError } = await T(sb, "albums")
        .select("id", { count: "exact", head: true })
        .eq("artist_id", artistId).eq("artist_audio_visible", true);
      if (countError) throw countError;
      if (!count) {
        const { error } = await T(sb, "artists")
          .update({ visibility: "private", artist_audio_visible: false }).eq("id", artistId);
        if (error) throw error;
      }
    }
  }
}
