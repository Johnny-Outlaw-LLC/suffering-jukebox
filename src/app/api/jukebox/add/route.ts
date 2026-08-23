// POST /api/jukebox/add — put a song in the queue.
//
// This is the only place a queue row is created. Whether the add is allowed is
// decided entirely by decideAdd() in src/lib/jukebox.ts, so the cap, the
// duplicate rule, the ban and the offline setting cannot drift between the
// guest app and the host console.
import { NextRequest, NextResponse } from "next/server";
import { decideAdd } from "@/lib/jukebox";
import { getTrackForQueue, insertQueueItem, loadPending } from "@/lib/jukebox-db";
import {
  bad,
  clientIp,
  isOwnerRequest,
  rateLimited,
  resolveRoom,
  tooMany,
} from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ctx = await resolveRoom(req, body.code);
    if ("error" in ctx) return ctx.error;
    const { sb, jukebox, guest } = ctx;

    const ip = clientIp(req);
    if (rateLimited(`add:${ip}`, 30)) return tooMany();

    const trackId = uuid(body.track_id ?? body.trackId);
    if (!trackId) return bad("Missing track.");

    const isOwner = await isOwnerRequest(req, jukebox);
    if (!isOwner && !guest) {
      return NextResponse.json(
        { ok: false, code: "no_seat", error: "Join the jukebox before adding a song." },
        { status: 401 },
      );
    }

    const track = await getTrackForQueue(sb, trackId);
    if (!track) return bad("That song is not in the collection.", 404);

    const pending = await loadPending(sb, jukebox.id);
    const decision = decideAdd({
      isLive: jukebox.is_live,
      settings: jukebox.settings,
      guestBanned: !!guest?.is_banned,
      pending,
      guestId: isOwner ? null : (guest?.id ?? null),
      trackId,
      trackIsExplicit: track.explicit,
      isOwner,
    });

    if (!decision.ok) {
      // 409, not 400: the request was well formed, the room's rules said no.
      return NextResponse.json(
        { ok: false, code: decision.code, error: decision.message },
        { status: 409 },
      );
    }

    const item = await insertQueueItem(sb, {
      jukeboxId: jukebox.id,
      trackId,
      videoId: typeof body.video_id === "string" ? body.video_id.slice(0, 40) : null,
      guestId: isOwner ? null : (guest?.id ?? null),
      addedByName: isOwner ? jukebox.name : (guest?.display_name ?? "Guest"),
      addedByOwner: isOwner,
      sort: decision.sort,
    });

    return NextResponse.json({ ok: true, item });
  } catch (err) {
    console.error("[jukebox:add]", err);
    return bad("Could not add that song.", 500);
  }
}
