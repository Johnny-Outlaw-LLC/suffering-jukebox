import { createB2DownloadUrl } from "@/lib/b2-audio";
import {
  deepgramConfigured,
  DeepgramError,
  formatCuesAsTranscript,
  submitDeepgramUrl,
  transcribeDeepgramUrlSync,
} from "@/lib/deepgram";
import { SITE_URL } from "@/lib/site";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

const T = (sb: ReturnType<typeof createSjServiceClient>, table: string) =>
  sb.schema(JUKEBOX_SCHEMA).from(table);

/** Sync for short clips; async webhook for anything that might run long. */
const SYNC_MAX_MS = 3 * 60 * 1000;

function callbackUrl(itemId: string): string | null {
  const secret = process.env.DEEPGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  const base = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || SITE_URL).replace(/\/$/, "");
  const url = new URL(`${base}/api/research/transcript-webhook`);
  url.searchParams.set("item", itemId);
  url.searchParams.set("secret", secret);
  return url.toString();
}

/**
 * Resolve a publicly reachable audio URL for Deepgram (signed B2 or stored URL).
 */
export async function resolveResearchAudioUrl(row: {
  storage_path?: string | null;
  audio_url?: string | null;
}): Promise<string | null> {
  if (row.storage_path) {
    try {
      return await createB2DownloadUrl(row.storage_path, 6 * 60 * 60);
    } catch (e) {
      console.warn("[research] signed audio url", e);
    }
  }
  const url = row.audio_url?.trim();
  if (url && /^https?:\/\//i.test(url) && !/youtube\.com|youtu\.be/i.test(url)) {
    return url;
  }
  return null;
}

export type DeepgramKickResult =
  | { status: "ready"; text: string; source: "deepgram" }
  | { status: "pending"; requestId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Prefer YouTube captions elsewhere. This is only for direct audio we host or link.
 * Marks the row deepgram_pending when the job is async.
 */
export async function kickDeepgramForItem(
  itemId: string,
  opts?: { durationMs?: number | null; forceSync?: boolean },
): Promise<DeepgramKickResult> {
  if (!deepgramConfigured()) {
    return { status: "skipped", reason: "Deepgram is not configured on this deployment." };
  }

  const sb = createSjServiceClient();
  const { data: row, error } = await T(sb, "research_items")
    .select("id,transcript,transcript_source,storage_path,audio_url,duration_ms,metadata")
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { status: "skipped", reason: "Item not found." };
  if (row.transcript && row.transcript_source !== "deepgram_pending") {
    return { status: "skipped", reason: "Transcript already present." };
  }

  const audioUrl = await resolveResearchAudioUrl(row);
  if (!audioUrl) {
    return { status: "skipped", reason: "No direct audio URL to send to Deepgram." };
  }

  const durationMs =
    opts?.durationMs ?? (row.duration_ms == null ? null : Number(row.duration_ms));
  const useSync =
    opts?.forceSync ||
    process.env.DEEPGRAM_SYNC === "1" ||
    (durationMs != null && durationMs > 0 && durationMs <= SYNC_MAX_MS);

  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? { ...(row.metadata as Record<string, unknown>) }
      : {};

  try {
    if (useSync) {
      const parsed = await transcribeDeepgramUrlSync(audioUrl);
      const text = formatCuesAsTranscript(parsed.cues, parsed.body);
      meta.deepgram_request_id = parsed.requestId;
      meta.deepgram_word_count = parsed.wordCount;
      await T(sb, "research_items")
        .update({
          transcript: text,
          transcript_source: "deepgram",
          metadata: meta,
        })
        .eq("id", itemId);
      return { status: "ready", text, source: "deepgram" };
    }

    const cb = callbackUrl(itemId);
    if (!cb) {
      // Fall back to sync when the webhook secret is missing rather than stalling.
      const parsed = await transcribeDeepgramUrlSync(audioUrl);
      const text = formatCuesAsTranscript(parsed.cues, parsed.body);
      meta.deepgram_request_id = parsed.requestId;
      meta.deepgram_word_count = parsed.wordCount;
      await T(sb, "research_items")
        .update({
          transcript: text,
          transcript_source: "deepgram",
          metadata: meta,
        })
        .eq("id", itemId);
      return { status: "ready", text, source: "deepgram" };
    }

    const { requestId } = await submitDeepgramUrl(audioUrl, cb);
    meta.deepgram_request_id = requestId;
    await T(sb, "research_items")
      .update({
        transcript_source: "deepgram_pending",
        metadata: meta,
      })
      .eq("id", itemId);
    return { status: "pending", requestId };
  } catch (e) {
    const reason = e instanceof DeepgramError || e instanceof Error ? e.message : "Deepgram failed.";
    await T(sb, "research_items")
      .update({ transcript_source: "deepgram_failed" })
      .eq("id", itemId);
    return { status: "failed", reason };
  }
}
