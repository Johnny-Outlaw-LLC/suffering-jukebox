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

function isOwnPath(path: string, userId: string, trackId: string): boolean {
  return path.startsWith(`${userId}/${trackId}/`) && !path.includes("..");
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
      Boolean(row.storage_path) && isOwnPath(row.storage_path!, user.id, row.track_id),
    );
    const tracks = await Promise.all(ownRows.map(async (row) => {
      return {
        trackId: row.track_id,
        path: row.storage_path,
        url: await createB2DownloadUrl(row.storage_path!),
        duration: Number(row.duration_seconds) || null,
        uploadedBy: row.uploaded_by,
      };
    }));
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
      if (!isOwnPath(path, user.id, trackId)) return noStore({ ok: false, error: "Invalid audio path." }, 400);
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
    if (row.storage_path && isOwnPath(row.storage_path, user.id, trackId)) {
      await deleteB2AudioObject(row.storage_path);
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
