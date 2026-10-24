import { sjBrowserAuth } from "@/lib/sj-browser-auth";

export type Artist = { id: string; name: string; slug: string | null };
export type DraftTrack = { id: string; name: string; track_number: number; disc_number: number;
  duration_ms: number | null; audio: { file_bytes: number } | null };
export type DraftRelease = { id: string; artist_id: string; name: string; release_date: string | null;
  is_unreleased: boolean; art_storage_path: string | null; art_preview_url: string | null;
  submitted_at: string | null; published_album_id: string | null; artist: Artist | null; tracks: DraftTrack[] };
export type Grant = { artist_id: string; limit_bytes: number };

export const MB = 1024 * 1024;
/** Mirrors MAX_UPLOAD_BYTES / MAX_VERIFIED_ARTIST_UPLOAD_BYTES in /api/sj-audio. */
export const FILE_LIMIT = 50 * MB;
export const VERIFIED_FILE_LIMIT = 250 * MB;
/** Mirrors USER_STORAGE_LIMITS: every account holds 500 MB until verified. */
export const ACCOUNT_LIMIT = 500 * MB;

export async function authHeaders() {
  const { data: { session } } = await sjBrowserAuth.auth.getSession();
  if (!session) throw new Error("Sign in to upload music.");
  return { Authorization: `Bearer ${session.access_token}` };
}

export async function post(action: string, body: Record<string, unknown>) {
  const response = await fetch("/api/artist-discography", {
    method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders() },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "Could not save that change.");
  return data;
}

export async function durationOf(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio();
      const done = (value: number | null) => { audio.src = ""; resolve(value); };
      audio.preload = "metadata";
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
      audio.onerror = () => done(null);
      audio.src = url;
      setTimeout(() => done(null), 5000);
    });
  } finally { URL.revokeObjectURL(url); }
}

/** Browsers often leave File.type empty for .flac. */
export function audioContentType(file: File): string {
  if (/^audio\//.test(file.type)) return file.type;
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
    opus: "audio/opus", wav: "audio/wav", flac: "audio/flac", webm: "audio/webm" } as Record<string, string>)[ext] ?? "audio/mpeg";
}

/**
 * The PUT goes straight to B2 through XMLHttpRequest, because fetch still has
 * no upload progress and a bar that sits at 0% for a 40 MB WAV reads as stuck.
 */
function putWithProgress(url: string, file: File, contentType: string, onProgress: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("The upload was interrupted. Try again.")));
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(file);
  });
}

export async function uploadAudio(trackId: string, file: File, fileLimit: number, onProgress: (pct: number) => void) {
  if (file.size <= 0) throw new Error("This file is empty.");
  if (file.size > fileLimit) throw new Error(`Over ${fileLimit / MB} MB. Export it as FLAC or MP3 and add it again.`);
  const contentType = audioContentType(file);
  const headers = await authHeaders();
  const prepared = await fetch("/api/sj-audio", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "upload-url", trackId, fileName: file.name, contentType, fileBytes: file.size }),
  });
  const upload = await prepared.json().catch(() => ({}));
  if (!prepared.ok || !upload.ok) throw new Error(upload.error || "Could not start this upload.");
  await putWithProgress(upload.uploadUrl, file, contentType, onProgress);
  const duration = await durationOf(file);
  const completed = await fetch("/api/sj-audio", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "complete", trackId, path: upload.path, durationSeconds: duration }),
  });
  const result = await completed.json().catch(() => ({}));
  if (!completed.ok || !result.ok) throw new Error(result.error || "The file uploaded but could not be saved.");
}

export async function uploadCover(releaseId: string, file: File) {
  const form = new FormData();
  form.set("releaseId", releaseId);
  form.set("art", file);
  const response = await fetch("/api/artist-discography/art", { method: "POST", headers: await authHeaders(), body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "Cover upload failed.");
}

export function megabytes(bytes: number) {
  return bytes >= 100 * MB ? `${Math.round(bytes / MB)} MB` : `${(bytes / MB).toFixed(1)} MB`;
}
