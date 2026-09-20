import { NextRequest, NextResponse } from "next/server";
import { cleanText, isUuid } from "@/lib/artist-rights";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { RESERVED_SLUGS } from "@/lib/jukebox";

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
    return reply({ ok: true, grants, ownedArtists, releases: releases.map((release) => ({
      ...release,
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
      const { data: artist, error } = await sb.schema(JUKEBOX_SCHEMA).from("artists")
        .insert({ name, slug, is_community: true, added_by: user.email,
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
    return reply({ ok: false, error: "Invalid action." }, 400);
  } catch (error) {
    if (error instanceof Error && ["A required field is missing.", "Use a valid release date."].includes(error.message)) {
      return reply({ ok: false, error: error.message }, 400);
    }
    console.error("[artist-discography:post]", error);
    return reply({ ok: false, error: "Could not save the release draft." }, 500);
  }
}
