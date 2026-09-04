import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/artist-rights";
import {
  createB2DownloadUrl,
  createB2UploadUrl,
  deleteB2AudioObject,
  getB2AudioObjectSize,
} from "@/lib/b2-audio";
import { getAuthUser, createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { getUserLevel, USER_STORAGE_LIMITS } from "@/lib/user-levels";
import { recalcStorageUsed } from "@/lib/bg-entitlement";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const AUDIO_CONTENT_TYPE = /^audio\/[a-z0-9.+-]+$/i;
const LEGACY_AUDIO_BUCKET = "jukebox-audio";
const PLAYBACK_URL_SECONDS = 6 * 60 * 60;

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function parseTrackIds(value: string | null): string[] {
  return [...new Set(
    (value || "").split(",").map((id) => id.trim()).filter(isUuid).slice(0, 50),
  )];
}

function extensionFrom(name: string): string {
  const ext = name.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || "mp3";
  return ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "webm"].includes(ext) ? ext : "mp3";
}

function isSafeAudioPath(path: string): boolean {
  return !path.includes("\\")
    && !path.includes("..")
    && path.split("/").every(Boolean);
}

// B2 preserves the original key when moving an object. Existing personal
// uploads therefore use the legacy `trackId/file` layout, whereas all new
// uploads use `userId/trackId/file`. The database ownership predicate is the
// authority in both cases; this check only makes sure the stored key belongs
// to the requested track and cannot escape its expected prefix.
function isAuthorizedStoredPath(path: string, userId: string, trackId: string): boolean {
  if (!isSafeAudioPath(path)) return false;
  return path.startsWith(`${userId}/${trackId}/`) || path.startsWith(`${trackId}/`);
}

function isNewUploadPath(path: string, userId: string, trackId: string): boolean {
  return isSafeAudioPath(path) && path.startsWith(`${userId}/${trackId}/`);
}

function isLegacyUploadPath(path: string, trackId: string): boolean {
  return isSafeAudioPath(path) && path.startsWith(`${trackId}/`);
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  const trackIds = parseTrackIds(req.nextUrl.searchParams.get("track_ids"));
  if (!trackIds.length) return noStore({ ok: true, tracks: [] });

  try {
    const sb = createSjServiceClient();
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .select("track_id,storage_path,duration_seconds,uploaded_by")
      .eq("uploaded_by", user.id)
      .in("track_id", trackIds);
    if (error) throw error;
    const ownRows = (data || []).filter((row) =>
      Boolean(row.storage_path) && isAuthorizedStoredPath(row.storage_path!, user.id, row.track_id),
    );
    // Signing used to be one call per row, all in flight at once. Asking for a
    // whole artist made Supabase Storage answer 429 "Too many connections
    // issued to the database" and the request failed entirely. Legacy paths are
    // now signed in a single batched call, and B2 presigning is bounded.
    const legacyRows = ownRows.filter((row) => isLegacyUploadPath(row.storage_path!, row.track_id));
    const b2Rows = ownRows.filter((row) => !isLegacyUploadPath(row.storage_path!, row.track_id));

    const urlByPath = new Map<string, string>();

    if (legacyRows.length) {
      // The source bucket stays private and was retained during the B2 move.
      // Serve old uploads from it until their legacy keys are migrated.
      const { data: signed, error: signedError } = await sb.storage
        .from(LEGACY_AUDIO_BUCKET)
        .createSignedUrls(legacyRows.map((row) => row.storage_path!), PLAYBACK_URL_SECONDS);
      if (signedError) throw signedError;
      for (const entry of signed || []) {
        if (entry?.path && entry?.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
      }
    }

    const B2_CONCURRENCY = 8;
    for (let i = 0; i < b2Rows.length; i += B2_CONCURRENCY) {
      const chunk = b2Rows.slice(i, i + B2_CONCURRENCY);
      const urls = await Promise.all(chunk.map((row) => createB2DownloadUrl(row.storage_path!)));
      chunk.forEach((row, j) => { if (urls[j]) urlByPath.set(row.storage_path!, urls[j]!); });
    }

    // A row we could not sign is skipped rather than failing the whole batch,
    // so one bad object cannot cost the caller an entire album.
    const tracks = ownRows.flatMap((row) => {
      const url = urlByPath.get(row.storage_path!);
      if (!url) return [];
      return [{
        trackId: row.track_id,
        path: row.storage_path,
        url,
        duration: Number(row.duration_seconds) || null,
        uploadedBy: row.uploaded_by,
      }];
    });
    return noStore({ ok: true, tracks });
  } catch (error) {
    console.error("[sj-audio] private URLs", error);
    return noStore({ ok: false, error: "Could not authorize private audio." }, 500);
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return noStore({ ok: false, error: "Invalid request." }, 400); }

  const action = String(body.action || "");
  const trackId = String(body.trackId || "");
  if (!isUuid(trackId)) return noStore({ ok: false, error: "Invalid track." }, 400);

  try {
    const sb = createSjServiceClient();
    if (action === "upload-url") {
      const fileName = String(body.fileName || "");
      const contentType = String(body.contentType || "audio/mpeg").toLowerCase();
      const fileBytes = Number(body.fileBytes);
      if (!Number.isSafeInteger(fileBytes) || fileBytes <= 0 || fileBytes > MAX_UPLOAD_BYTES) {
        return noStore({ ok: false, error: "Invalid audio file size." }, 400);
      }
      if (!AUDIO_CONTENT_TYPE.test(contentType)) return noStore({ ok: false, error: "Audio files only." }, 400);

      const level = await getUserLevel(user.email);
      const limit = USER_STORAGE_LIMITS[level];
      const { data: existing, error: existingError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("track_audio")
        .select("file_bytes")
        .eq("track_id", trackId)
        .eq("uploaded_by", user.id)
        .maybeSingle();
      if (existingError) throw existingError;
      const used = await recalcStorageUsed(sb, user.id);
      const replacing = Number(existing?.file_bytes || 0);
      if (limit <= 0 || used - replacing + fileBytes > limit) {
        return noStore({ ok: false, error: "Not enough storage in your account." }, 409);
      }

      const key = `${user.id}/${trackId}/${crypto.randomUUID()}.${extensionFrom(fileName)}`;
      return noStore({ ok: true, path: key, uploadUrl: await createB2UploadUrl(key, contentType) });
    }

    if (action === "complete") {
      const path = String(body.path || "");
      const durationSeconds = Number(body.durationSeconds);
      if (!isNewUploadPath(path, user.id, trackId)) return noStore({ ok: false, error: "Invalid audio path." }, 400);
      const fileBytes = await getB2AudioObjectSize(path);
      if (fileBytes <= 0 || fileBytes > MAX_UPLOAD_BYTES) return noStore({ ok: false, error: "Invalid uploaded audio." }, 400);

      const { data: previous, error: previousError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("track_audio")
        .select("storage_path")
        .eq("track_id", trackId)
        .eq("uploaded_by", user.id)
        .maybeSingle();
      if (previousError) throw previousError;
      const { error: saveError } = await sb.schema(JUKEBOX_SCHEMA).from("track_audio").upsert({
        track_id: trackId,
        storage_path: path,
        source_video_id: typeof body.sourceVideoId === "string" ? body.sourceVideoId || null : null,
        duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
        uploaded_by: user.id,
        uploader_email: user.email || null,
        uploader_name: typeof body.uploaderName === "string" ? body.uploaderName || null : null,
        consent_at: new Date().toISOString(),
        is_public: false,
        file_bytes: fileBytes,
      }, { onConflict: "track_id,uploaded_by" });
      if (saveError) throw saveError;
      if (previous?.storage_path && previous.storage_path !== path) {
        await deleteB2AudioObject(previous.storage_path).catch(() => undefined);
      }
      return noStore({
        ok: true,
        audio: { path, url: await createB2DownloadUrl(path), duration: Number.isFinite(durationSeconds) ? durationSeconds : null },
      });
    }

    return noStore({ ok: false, error: "Invalid audio action." }, 400);
  } catch (error) {
    console.error("[sj-audio] post", error);
    return noStore({ ok: false, error: "Could not save audio." }, 500);
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  let body: { trackId?: unknown };
  try { body = await req.json(); } catch { return noStore({ ok: false, error: "Invalid request." }, 400); }
  const trackId = String(body.trackId || "");
  if (!isUuid(trackId)) return noStore({ ok: false, error: "Invalid track." }, 400);

  try {
    const sb = createSjServiceClient();
    const { data: row, error: rowError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .select("storage_path")
      .eq("track_id", trackId)
      .eq("uploaded_by", user.id)
      .maybeSingle();
    if (rowError) throw rowError;
    if (!row) return noStore({ ok: true });
    if (row.storage_path && isAuthorizedStoredPath(row.storage_path, user.id, trackId)) {
      if (isLegacyUploadPath(row.storage_path, trackId)) {
        const { error: removeError } = await sb.storage.from(LEGACY_AUDIO_BUCKET).remove([row.storage_path]);
        if (removeError) throw removeError;
      } else {
        await deleteB2AudioObject(row.storage_path);
      }
    }
    const { error: deleteError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .delete()
      .eq("track_id", trackId)
      .eq("uploaded_by", user.id);
    if (deleteError) throw deleteError;
    return noStore({ ok: true });
  } catch (error) {
    console.error("[sj-audio] delete", error);
    return noStore({ ok: false, error: "Could not delete audio." }, 500);
  }
}
