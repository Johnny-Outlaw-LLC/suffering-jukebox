// GET /api/jukebox/lyrics?code=<room>&trackId=<uuid>
//
// The guest half of the karaoke. The dashboard reads lyrics straight from
// PostgREST with the anon key, but the Interactive Jukebox tables have no anon
// grants at all and the guest app holds no key, so its lyrics come through
// here with everything else: one route, one room check, one shape.
//
// LRC parsing happens on the server so the phone gets timed lines it can paint
// without shipping a parser, and so the line list matches what the host is
// highlighting on the TV exactly.
import { NextRequest, NextResponse } from "next/server";
import { loadTrackLyrics } from "@/lib/jukebox-db";
import { bad, clientIp, rateLimited, resolveRoom, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

/** Same grammar as parseLRC() in public/index.html. Keep the two in step. */
function parseLRC(lrc: string | null): { t: number; text: string }[] | null {
  if (!lrc) return null;
  const lines: { t: number; text: string }[] = [];
  for (const raw of lrc.split("\n")) {
    const m = raw.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  }
  return lines.length ? lines : null;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    if (rateLimited(`lyrics:${clientIp(req)}`, 300)) return tooMany();

    const ctx = await resolveRoom(req, url.searchParams.get("code"));
    if ("error" in ctx) return ctx.error;

    const trackId = uuid(url.searchParams.get("trackId"));
    if (!trackId) return bad("Missing track.");

    const { plain, synced } = await loadTrackLyrics(ctx.sb, trackId);
    return NextResponse.json({
      ok: true,
      trackId,
      plain: plain?.trim() || null,
      synced: parseLRC(synced),
    });
  } catch (err) {
    console.error("[jukebox:lyrics]", err);
    return bad("Could not read the lyrics.", 500);
  }
}
