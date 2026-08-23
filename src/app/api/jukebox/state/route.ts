// GET /api/jukebox/state?code=XXXXXX&since=<iso>
//
// The 5s poll behind both the guest app and the host console. `since` returns
// only what arrived after that moment, which is what fires the
// "Artist — Track added by NAME" toast without replaying the whole queue.
import { NextRequest, NextResponse } from "next/server";
import { loadQueue, loadRecentlyPlayed, touchGuest } from "@/lib/jukebox-db";
import {
  bad,
  clientIp,
  publicGuest,
  publicJukebox,
  rateLimited,
  resolveRoom,
  tooMany,
} from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const ip = clientIp(req);
    // A 5s poll is 12 requests a minute; this leaves room for a few tabs.
    if (rateLimited(`state:${ip}`, 90)) return tooMany();

    const ctx = await resolveRoom(req, url.searchParams.get("code"));
    if ("error" in ctx) return ctx.error;
    const { sb, jukebox, guest } = ctx;

    const queue = await loadQueue(sb, jukebox.id);
    const nowPlaying = queue.find((q) => q.status === "playing") ?? null;
    const waiting = queue.filter((q) => q.status === "pending");

    // Anything that arrived since the caller last looked. The client uses this
    // for the toast; it deliberately excludes the caller's own adds, which are
    // already confirmed to them by the add response.
    const sinceRaw = url.searchParams.get("since");
    const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
    const newAdds = Number.isFinite(sinceMs)
      ? waiting.filter(
          (q) => Date.parse(q.createdAt) > sinceMs && (!guest || q.guestId !== guest.id),
        )
      : [];

    if (guest) touchGuest(sb, guest.id).catch(() => {});

    const includePlayed = url.searchParams.get("played") === "1";
    const recentlyPlayed = includePlayed ? await loadRecentlyPlayed(sb, jukebox.id) : undefined;

    return NextResponse.json({
      ok: true,
      jukebox: publicJukebox(jukebox),
      guest: publicGuest(guest),
      nowPlaying,
      queue: waiting,
      newAdds,
      recentlyPlayed,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[jukebox:state]", err);
    return bad("Could not read the jukebox.", 500);
  }
}
