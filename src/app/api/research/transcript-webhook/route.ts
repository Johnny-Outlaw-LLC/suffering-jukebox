import { NextRequest, NextResponse } from "next/server";
import { DeepgramError, formatCuesAsTranscript, parseDeepgramResponse } from "@/lib/deepgram";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { isUuid } from "@/lib/artist-rights";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deepgram async callback for Artist Deep Dive uploads.
 * Query: item=<research_items.id>&secret=<DEEPGRAM_WEBHOOK_SECRET>
 * Body: finished listen payload (paragraphs, not utterances — see deepgram.ts).
 */

function authorized(req: NextRequest): boolean {
  const expected = process.env.DEEPGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  const got = req.nextUrl.searchParams.get("secret");
  return Boolean(got) && got === expected;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }

  const itemId = req.nextUrl.searchParams.get("item")?.trim() || "";
  if (!isUuid(itemId)) {
    return NextResponse.json({ error: "item is required." }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  try {
    const parsed = parseDeepgramResponse(payload);
    const text = formatCuesAsTranscript(parsed.cues, parsed.body);
    const sb = createSjServiceClient();
    const { data: row } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("research_items")
      .select("id,transcript,transcript_source,metadata")
      .eq("id", itemId)
      .maybeSingle();
    if (!row) {
      // 200 so Deepgram does not retry forever for a deleted item.
      return NextResponse.json({ ok: true, skipped: "missing" });
    }
    // Idempotent: if a real transcript already landed, leave it alone.
    if (row.transcript && row.transcript_source && row.transcript_source !== "deepgram_pending") {
      return NextResponse.json({ ok: true, skipped: "already_ready" });
    }

    const meta =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? { ...(row.metadata as Record<string, unknown>) }
        : {};
    meta.deepgram_request_id = parsed.requestId;
    meta.deepgram_word_count = parsed.wordCount;

    const { error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("research_items")
      .update({
        transcript: text,
        transcript_source: "deepgram",
        metadata: meta,
      })
      .eq("id", itemId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[research:deepgram-webhook]", error);
    // 200 on purpose: Deepgram retries a failure, and a retry cannot fix a
    // parse bug. Log and move on; the detail card can offer "Try again".
    const message =
      error instanceof DeepgramError || error instanceof Error ? error.message : "failed";
    try {
      const sb = createSjServiceClient();
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("research_items")
        .update({ transcript_source: "deepgram_failed" })
        .eq("id", itemId)
        .eq("transcript_source", "deepgram_pending");
    } catch (_) {}
    return NextResponse.json({ ok: false, error: message });
  }
}
