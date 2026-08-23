// POST /api/jukebox/remove — a guest pulls back one of their own songs.
//
// Guests get exactly this one power over the queue. They cannot reorder, and
// they cannot touch anybody else's song. Owner removals go through
// /api/jukebox/owner instead.
import { NextRequest, NextResponse } from "next/server";
import { canGuestRemove } from "@/lib/jukebox";
import { getQueueItem, removeQueueItem } from "@/lib/jukebox-db";
import { bad, clientIp, rateLimited, resolveRoom, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ctx = await resolveRoom(req, body.code);
    if ("error" in ctx) return ctx.error;
    const { sb, jukebox, guest } = ctx;

    if (rateLimited(`remove:${clientIp(req)}`, 40)) return tooMany();
    if (!guest) return bad("Join the jukebox first.", 401);

    const itemId = uuid(body.item_id ?? body.itemId);
    if (!itemId) return bad("Missing queue item.");

    const item = await getQueueItem(sb, itemId, jukebox.id);
    if (!item) return bad("That song is no longer in the queue.", 404);

    if (!canGuestRemove({ guestId: item.guest_id, status: item.status }, guest.id)) {
      // Deliberately the same message whether it belongs to someone else or is
      // already playing, so the queue cannot be probed for who added what.
      return NextResponse.json(
        { ok: false, error: "You can only remove songs you added, and only while they are waiting." },
        { status: 403 },
      );
    }

    await removeQueueItem(sb, itemId, `guest:${guest.id}`);
    return NextResponse.json({ ok: true, removed: itemId });
  } catch (err) {
    console.error("[jukebox:remove]", err);
    return bad("Could not remove that song.", 500);
  }
}
