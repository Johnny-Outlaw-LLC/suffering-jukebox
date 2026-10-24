import { NextRequest, NextResponse } from "next/server";
import { cleanText, isUuid } from "@/lib/artist-rights";
import { createB2DownloadUrl, deleteB2AudioObject, isOwnedAudioKey } from "@/lib/b2-audio";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { RESERVED_SLUGS } from "@/lib/jukebox";

type ServiceClient = ReturnType<typeof createSjServiceClient>;

/**
 * A draft release the caller owns and can still change. Once it has been
 * signed for (submitted_at) or published it belongs to the review, and every
 * edit action refuses it.
 */
async function editableRelease(sb: ServiceClient, userId: string, releaseId: string) {
  if (!isUuid(releaseId)) return null;
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_releases")
    .select("id,art_storage_path,submitted_at,published_album_id")
    .eq("id", releaseId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data || data.submitted_at || data.published_album_id) return null;
  return data;
}

async function editableTrack(sb: ServiceClient, userId: string, trackId: string) {
  if (!isUuid(trackId)) return null;
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
    .select("id,release_id").eq("id", trackId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data || !(await editableRelease(sb, userId, data.release_id))) return null;
  return data;
}

/**
 * track_audio has no foreign key to the draft track, so removing a draft
 * track has to take its audio (row and B2 object) with it, or the file keeps
 * counting against the artist's storage with nothing pointing at it.
 */
async function deleteDraftAudio(sb: ServiceClient, userId: string, trackIds: string[]) {
  if (!trackIds.length) return;
  const { data: rows, error } = await sb.schema(JUKEBOX_SCHEMA).from("track_audio")
    .select("track_id,storage_path").eq("uploaded_by", userId).in("track_id", trackIds);
  if (error) throw error;
  for (const row of rows ?? []) {
    if (row.storage_path && isOwnedAudioKey(row.storage_path, userId, row.track_id)) {
      await deleteB2AudioObject(row.storage_path).catch(() => undefined);
    }
  }
  const { error: deleteError } = await sb.schema(JUKEBOX_SCHEMA).from("track_audio")
    .delete().eq("uploaded_by", userId).in("track_id", trackIds);
  if (deleteError) throw deleteError;
}

export const dynamic = "force-dynamic";

const reply = (body: unknown, status = 200) => NextResponse.json(body, {
  status,
  headers: { "Cache-Control": "private, no-store" },
});

function releaseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("Use a valid release date.");
  }
  return date;
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return reply({ ok: false, error: "Sign in required." }, 401);
  try {
    const sb = createSjServiceClient();
    const { data: grants, error: grantsError } = await sb.schema(JUKEBOX_SCHEMA)
      .from("artist_upload_grants").select("artist_id,limit_bytes")
      .eq("user_email", (user.email || "").toLowerCase());
    if (grantsError) throw grantsError;
    const { data: ownedArtists, error: ownedError } = await sb.schema(JUKEBOX_SCHEMA)
      .from("artists").select("id,name,slug")
      .eq("artist_upload_created_by", user.id);
    if (ownedError) throw ownedError;
    const { data: releases, error } = await sb.schema(JUKEBOX_SCHEMA)
      .from("artist_upload_releases")
      .select("id,artist_id,name,release_date,is_unreleased,art_url,art_storage_path,submitted_at,published_album_id,created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    if (!releases?.length) return reply({ ok: true, releases: [], grants, ownedArtists });
    const releaseIds = releases.map((row) => row.id);
    const [{ data: artists, error: artistError }, { data: tracks, error: trackError }] = await Promise.all([
      sb.schema(JUKEBOX_SCHEMA).from("artists").select("id,name,slug").in("id", [...new Set(releases.map((row) => row.artist_id))]),
      sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
        .select("id,release_id,name,disc_number,track_number,duration_ms,explicit")
        .in("release_id", releaseIds).eq("user_id", user.id),
    ]);
    if (artistError || trackError) throw artistError || trackError;
    const trackIds = (tracks ?? []).map((row) => row.id);
    const { data: audio, error: audioError } = trackIds.length
      ? await sb.schema(JUKEBOX_SCHEMA).from("track_audio")
          .select("id,track_id,file_bytes").eq("uploaded_by", user.id).in("track_id", trackIds)
      : { data: [], error: null };
    if (audioError) throw audioError;
    const artistMap = new Map((artists ?? []).map((row) => [row.id, row]));
    const audioMap = new Map((audio ?? []).map((row) => [row.track_id, row]));
    // /artist-release-art only serves published covers, so a draft's cover is
    // shown to its owner through a short-lived signed link instead.
    const artPreview = new Map<string, string | null>();
    await Promise.all(releases.filter((row) => row.art_storage_path).map(async (row) => {
      artPreview.set(row.id, await createB2DownloadUrl(row.art_storage_path!, 60 * 60).catch(() => null));
    }));
    return reply({ ok: true, grants, ownedArtists, releases: releases.map((release) => ({
      ...release,
      art_preview_url: artPreview.get(release.id) ?? null,
      artist: artistMap.get(release.artist_id) ?? null,
      tracks: (tracks ?? []).filter((track) => track.release_id === release.id)
        .sort((a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number)
        .map((track) => ({ ...track, audio: audioMap.get(track.id) ?? null })),
    })) });
  } catch (error) {
    console.error("[artist-discography:get]", error);
    return reply({ ok: false, error: "Could not load your release drafts." }, 500);
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) return reply({ ok: false, error: "Sign in required." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ ok: false, error: "Invalid request." }, 400); }
  const sb = createSjServiceClient();
  try {
    if (body.action === "create-artist") {
      const name = cleanText(body.name, 160, true) as string;
      const { data: matching, error: matchError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("artists").select("id,visibility,artist_upload_created_by")
        .ilike("name", name.replace(/[%_]/g, "\\$&")).limit(5);
      if (matchError) throw matchError;
      const existing = (matching ?? []).find((row) => row.visibility === "public" || row.artist_upload_created_by === user.id);
      if (existing) return reply({ ok: true, artistId: existing.id, existing: true });
      if (matching?.length) return reply({ ok: false, error: "That artist name is already in review." }, 409);
      const { count, error: countError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("artists").select("id", { count: "exact", head: true }).eq("artist_upload_created_by", user.id);
      if (countError) throw countError;
      if ((count ?? 0) >= 10) return reply({ ok: false, error: "Contact support to stage more than 10 artists." }, 409);
      const base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 68) || "artist";
      const prefix = RESERVED_SLUGS.has(base) ? `${base}-music` : base;
      const { data: slugUsed, error: slugError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("artists").select("id").eq("slug", prefix).maybeSingle();
      if (slugError) throw slugError;
      const slug = slugUsed ? `${prefix}-${crypto.randomUUID().slice(0, 8)}` : prefix;
      // added_by_name is what "Added by" and the Submitted By filter read.
      // Same name the rest of the app credits: the chosen public name, else
      // whatever Google said.
      const { data: me } = await sb.schema(JUKEBOX_SCHEMA).from("app_users")
        .select("public_name,user_name").ilike("email", user.email).maybeSingle();
      const addedByName = (me?.public_name || "").trim() || (me?.user_name || "").trim()
        || (user.user_metadata?.full_name as string | undefined) || null;
      const { data: artist, error } = await sb.schema(JUKEBOX_SCHEMA).from("artists")
        .insert({ name, slug, is_community: true, added_by: user.email, added_by_name: addedByName,
          visibility: "private", discography_complete: false,
          artist_audio_visible: false, artist_upload_created_by: user.id })
        .select("id").single();
      if (error) throw error;
      return reply({ ok: true, artistId: artist.id, existing: false });
    }
    if (body.action === "create-release") {
      const artistId = String(body.artistId || "");
      if (!isUuid(artistId)) return reply({ ok: false, error: "Choose an artist." }, 400);
      const name = cleanText(body.name, 200, true);
      const date = releaseDate(body.releaseDate);
      const isUnreleased = body.isUnreleased === true;
      if (isUnreleased && date) return reply({ ok: false, error: "An unreleased collection cannot have a public release date." }, 400);
      const { data: artist, error: artistError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("artists").select("id,name,visibility,artist_upload_created_by").eq("id", artistId).maybeSingle();
      if (artistError) throw artistError;
      if (!artist || (artist.visibility !== "public" && artist.artist_upload_created_by !== user.id)) {
        return reply({ ok: false, error: "Artist not found." }, 404);
      }
      const { count, error: countError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("artist_upload_releases").select("id", { count: "exact", head: true }).eq("user_id", user.id);
      if (countError) throw countError;
      if ((count ?? 0) >= 100) return reply({ ok: false, error: "Contact support to add more than 100 releases." }, 409);
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_releases")
        .insert({ user_id: user.id, artist_id: artistId, name, release_date: date, is_unreleased: isUnreleased })
        .select("id").single();
      if (error) throw error;
      return reply({ ok: true, releaseId: data.id });
    }

    if (body.action === "create-track") {
      const releaseId = String(body.releaseId || "");
      if (!isUuid(releaseId)) return reply({ ok: false, error: "Choose a release." }, 400);
      const { data: release, error: releaseError } = await sb.schema(JUKEBOX_SCHEMA)
        .from("artist_upload_releases").select("id,submitted_at,published_album_id")
        .eq("id", releaseId).eq("user_id", user.id).maybeSingle();
      if (releaseError) throw releaseError;
      if (!release || release.submitted_at || release.published_album_id) return reply({ ok: false, error: "Release is unavailable for editing." }, 403);
      const name = cleanText(body.name, 200, true);
      const disc = Number(body.discNumber ?? 1);
      const number = Number(body.trackNumber);
      const duration = Number(body.durationMs);
      if (!Number.isInteger(disc) || disc < 1 || disc > 99 || !Number.isInteger(number) || number < 1 || number > 999) {
        return reply({ ok: false, error: "Use valid disc and track numbers." }, 400);
      }
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
        .insert({ release_id: releaseId, user_id: user.id, name, disc_number: disc, track_number: number,
          duration_ms: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
          explicit: body.explicit === true })
        .select("id").single();
      if (error?.code === "23505") return reply({ ok: false, error: "That disc and track number already exists on this release." }, 409);
      if (error) throw error;
      return reply({ ok: true, trackId: data.id });
    }

    if (body.action === "update-release") {
      const release = await editableRelease(sb, user.id, String(body.releaseId || ""));
      if (!release) return reply({ ok: false, error: "This release can no longer be edited." }, 403);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = cleanText(body.name, 200, true);
      if (body.isUnreleased !== undefined) patch.is_unreleased = body.isUnreleased === true;
      if (body.releaseDate !== undefined) patch.release_date = releaseDate(body.releaseDate);
      if (patch.is_unreleased === true) patch.release_date = null;
      if (!Object.keys(patch).length) return reply({ ok: true });
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_releases")
        .update(patch).eq("id", release.id).eq("user_id", user.id);
      if (error) throw error;
      return reply({ ok: true });
    }

    if (body.action === "update-track") {
      const track = await editableTrack(sb, user.id, String(body.trackId || ""));
      if (!track) return reply({ ok: false, error: "This song can no longer be edited." }, 403);
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
        .update({ name: cleanText(body.name, 200, true) }).eq("id", track.id).eq("user_id", user.id);
      if (error) throw error;
      return reply({ ok: true });
    }

    if (body.action === "reorder-tracks") {
      const release = await editableRelease(sb, user.id, String(body.releaseId || ""));
      if (!release) return reply({ ok: false, error: "This release can no longer be edited." }, 403);
      const order = Array.isArray(body.trackIds) ? body.trackIds.map(String) : [];
      const { data: rows, error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
        .select("id,track_number").eq("release_id", release.id).eq("user_id", user.id);
      if (error) throw error;
      const ids = new Set((rows ?? []).map((row) => row.id));
      if (order.length !== ids.size || order.some((id) => !ids.has(id)) || new Set(order).size !== order.length) {
        return reply({ ok: false, error: "Send every song on the release exactly once." }, 400);
      }
      // (release, disc, track_number) is unique and not deferrable, so the
      // songs step through numbers nobody holds before landing on 1..n.
      const parked = Math.max(0, ...(rows ?? []).map((row) => row.track_number));
      if (parked + order.length > 999) return reply({ ok: false, error: "Too many songs to reorder." }, 400);
      for (const offset of [parked, 0]) {
        for (let i = 0; i < order.length; i++) {
          const { error: moveError } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
            .update({ track_number: offset + i + 1, disc_number: 1 }).eq("id", order[i]).eq("user_id", user.id);
          if (moveError) throw moveError;
        }
      }
      return reply({ ok: true });
    }

    if (body.action === "delete-track") {
      const track = await editableTrack(sb, user.id, String(body.trackId || ""));
      if (!track) return reply({ ok: false, error: "This song can no longer be removed." }, 403);
      await deleteDraftAudio(sb, user.id, [track.id]);
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
        .delete().eq("id", track.id).eq("user_id", user.id);
      if (error) throw error;
      return reply({ ok: true });
    }

    if (body.action === "delete-release") {
      const release = await editableRelease(sb, user.id, String(body.releaseId || ""));
      if (!release) return reply({ ok: false, error: "This release can no longer be removed." }, 403);
      const { data: rows, error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_tracks")
        .select("id").eq("release_id", release.id).eq("user_id", user.id);
      if (error) throw error;
      await deleteDraftAudio(sb, user.id, (rows ?? []).map((row) => row.id));
      if (release.art_storage_path?.startsWith(`artist-covers/${user.id}/${release.id}/`)) {
        await deleteB2AudioObject(release.art_storage_path).catch(() => undefined);
      }
      // Tracks go with it (on delete cascade).
      const { error: deleteError } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_releases")
        .delete().eq("id", release.id).eq("user_id", user.id);
      if (deleteError) throw deleteError;
      return reply({ ok: true });
    }
    return reply({ ok: false, error: "Invalid action." }, 400);
  } catch (error) {
    if (error instanceof Error && ["A required field is missing.", "Use a valid release date."].includes(error.message)) {
      return reply({ ok: false, error: error.message }, 400);
    }
    console.error("[artist-discography:post]", error);
    return reply({ ok: false, error: "Could not save the release draft." }, 500);
  }
}
