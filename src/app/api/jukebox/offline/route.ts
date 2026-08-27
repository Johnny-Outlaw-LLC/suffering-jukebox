// GET /api/jukebox/offline?code=XXXXXX — the last playlist that was on air.
//
// A station that has gone quiet is not a dead page. Whoever turns up can still
// load what the host was playing and listen to it on their own machine, which
// is the whole difference between "come back later" and a room that keeps
// working after closing time.
//
// The list comes from jukeboxes.last_queue, written by the host's own sync.
// See loadLastSyncedPlaylist() for why it is not rebuilt from jukebox_queue.
import { NextRequest, NextResponse } from "next/server";
import { loadLastSyncedPlaylist } from "@/lib/jukebox-db";
import { bad, clientIp, publicJukebox, rateLimited, resolveRoom, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    if (rateLimited(`offline:${clientIp(req)}`, 120)) return tooMany();

    const ctx = await resolveRoom(req, url.searchParams.get("code"));
    if ("error" in ctx) return ctx.error;
    const { sb, jukebox } = ctx;

    const tracks = await loadLastSyncedPlaylist(sb, jukebox);
    return NextResponse.json({
      ok: true,
      jukebox: publicJukebox(jukebox),
      // Nothing to play is a real answer, not an error: a room that has never
      // been on air has no last playlist and the page says so.
      tracks: tracks.filter((t) => !!t.videoId),
      // A stamp the guest can show: "last on air Saturday night".
      lastLiveAt: jukebox.last_live_at,
    });
  } catch (err) {
    console.error("[jukebox:offline]", err);
    return bad("Could not read the last playlist.", 500);
  }
}
