import { createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { approvedArtistAudioTracks } from "@/lib/bg-audio-eligibility";

/// What the car can stream without a download: the listener's own locker, plus
/// every song an artist has licensed. The three /api/sj-carplay-* routes read
/// from here so the list the car shows and the songs it is allowed to start
/// can never disagree.
///
/// Artist-licensed songs follow the mobile-background rule (any approved
/// agreement, any version), because that is what the car is: background play.

export const CARPLAY_URL_SECONDS = 6 * 60 * 60;

export type CarplaySource = "mine" | "artist";

export type CarplayTrack = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  source: CarplaySource;
};

// ── Keys ────────────────────────────────────────────────────────────

export function newCarKey(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashCarKey(raw) };
}

export function hashCarKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m ? m[1] : null;
}

/// The locker owner a car key belongs to, or null. A missing key is not an
/// error: a signed-out phone still gets the artist-licensed songs.
export async function carKeyUser(sb: SupabaseClient, req: NextRequest): Promise<string | null> {
  const raw = bearer(req);
  if (!raw) return null;
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA)
    .from("carplay_keys").select("id,user_id,last_used_at")
    .eq("token_hash", hashCarKey(raw)).is("revoked_at", null).maybeSingle();
  if (error || !data) return null;
  // Stamped at most hourly: a drive resolves a URL per song and none of those
  // writes would tell anybody anything the first one did not.
  const last = data.last_used_at ? Date.parse(data.last_used_at) : 0;
  if (Date.now() - last > 60 * 60 * 1000) {
    await sb.schema(JUKEBOX_SCHEMA).from("carplay_keys")
      .update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  }
  return data.user_id as string;
}

// ── Library ─────────────────────────────────────────────────────────

const CHUNK = 200;

async function inChunks<T>(ids: string[], fetch: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...await fetch(ids.slice(i, i + CHUNK)));
  return out;
}

/// Track ids -> car rows. Tracks the catalogue no longer holds are dropped.
async function describe(sb: SupabaseClient, sourceById: Map<string, CarplaySource>,
  durationById: Map<string, number | null>): Promise<CarplayTrack[]> {
  const ids = [...sourceById.keys()];
  if (!ids.length) return [];
  const tracks = await inChunks(ids, async (part) => {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("tracks")
      .select("id,name,album_id,duration_ms").in("id", part);
    if (error) throw error;
    return data ?? [];
  });
  const albumIds = [...new Set(tracks.map((t) => t.album_id).filter(Boolean))];
  const albums = await inChunks(albumIds, async (part) => {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("albums")
      .select("id,name,art_url,artist_id").in("id", part);
    if (error) throw error;
    return data ?? [];
  });
  const albumMap = new Map(albums.map((a) => [a.id, a]));
  const artistIds = [...new Set(albums.map((a) => a.artist_id).filter(Boolean))];
  const artists = await inChunks(artistIds, async (part) => {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("artists")
      .select("id,name").in("id", part);
    if (error) throw error;
    return data ?? [];
  });
  const artistMap = new Map(artists.map((a) => [a.id, a.name as string]));

  return tracks.map((t) => {
    const album = albumMap.get(t.album_id);
    const art = album?.art_url && /^https:\/\//i.test(album.art_url) ? album.art_url : null;
    const fileSeconds = durationById.get(t.id);
    return {
      id: t.id,
      title: t.name || "Untitled",
      artist: (album && artistMap.get(album.artist_id)) || "Unknown Artist",
      album: album?.name ?? null,
      artworkUrl: art,
      durationSeconds: fileSeconds || (t.duration_ms ? Math.round(t.duration_ms / 1000) : null),
      source: sourceById.get(t.id)!,
    };
  });
}

export async function carplayLibrary(sb: SupabaseClient, userId: string | null): Promise<CarplayTrack[]> {
  const sourceById = new Map<string, CarplaySource>();
  const durationById = new Map<string, number | null>();

  const licensed = await approvedArtistAudioTracks(sb);
  licensed.forEach((row) => sourceById.set(row.track_id, "artist"));

  if (userId) {
    // Own uploads win the label: "mine" is the one that still plays if the
    // artist later withdraws the licence.
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("track_audio")
      .select("track_id,storage_path,duration_seconds").eq("uploaded_by", userId);
    if (error) throw error;
    (data ?? []).filter((r) => r.storage_path).forEach((r) => {
      sourceById.set(r.track_id, "mine");
      durationById.set(r.track_id, Number(r.duration_seconds) || null);
    });
  }
  return describe(sb, sourceById, durationById);
}

/// The B2 key to sign for one track, applying the same two rules as the
/// library: the caller's own upload first, then an artist licence.
export async function carplayStoragePath(
  sb: SupabaseClient, trackId: string, userId: string | null,
): Promise<string | null> {
  if (userId) {
    const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("track_audio")
      .select("track_id,storage_path").eq("uploaded_by", userId).eq("track_id", trackId)
      .order("created_at", { ascending: false }).limit(1);
    if (error) throw error;
    const path = data?.[0]?.storage_path;
    if (path && isSafeOwnPath(path, userId, trackId)) return path;
  }
  const [licensed] = await approvedArtistAudioTracks(sb, [trackId]);
  if (!licensed) return null;
  const { data: audio, error } = await sb.schema(JUKEBOX_SCHEMA).from("track_audio")
    .select("storage_path").eq("id", licensed.track_audio_id).maybeSingle();
  if (error) throw error;
  return audio?.storage_path || null;
}

// Mirrors isAuthorizedStoredPath in /api/sj-audio: new uploads live under
// `userId/trackId/`, legacy ones under `trackId/`.
function isSafeOwnPath(path: string, userId: string, trackId: string): boolean {
  if (path.includes("\\") || path.includes("..") || !path.split("/").every(Boolean)) return false;
  return path.startsWith(`${userId}/${trackId}/`) || path.startsWith(`${trackId}/`);
}
