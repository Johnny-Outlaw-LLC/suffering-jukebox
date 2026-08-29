// POST /api/jukebox/reorder — a guest drags the waiting list into a new order.
//
// Off unless the host has turned "Allow guests to reorder" on. When it is on
// there is deliberately no further test of whose song it is: a guest with one
// song waiting can only ever move it past somebody else's, so a rule that
// forbade that would forbid the gesture. See allowGuestReorder in lib/jukebox.
//
// What still holds: the song on screen never moves, a banned guest moves
// nothing, and this grants no power to remove — that is /api/jukebox/remove,
// and it is still your own songs only.
import { NextRequest, NextResponse } from "next/server";
import { canGuestReorder, midpointSort, normalizeSettings } from "@/lib/jukebox";
import { getQueueItem, loadPending, setQueueItemSortByGuest } from "@/lib/jukebox-db";
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

    if (rateLimited(`reorder:${clientIp(req)}`, 60)) return tooMany();
    if (!guest) return bad("Join the jukebox first.", 401);

    const itemId = uuid(body.item_id ?? body.itemId);
    if (!itemId) return bad("Missing queue item.");

    const item = await getQueueItem(sb, itemId, jukebox.id);
    if (!item) return bad("That song is no longer in the queue.", 404);

    const settings = normalizeSettings(jukebox.settings);
    if (!canGuestReorder({
      settings,
      isLive: !!jukebox.is_live,
      guestBanned: !!guest.is_banned,
      status: item.status,
    })) {
      return NextResponse.json(
        { ok: false, error: "This jukebox is not letting guests reorder the queue." },
        { status: 403 },
      );
    }

    // The client sends the neighbours it was dropped between and the server
    // works out the value, so two people dragging at once cannot corrupt the
    // ordering of the whole queue. Same contract as the owner's reorder.
    const pending = (await loadPending(sb, jukebox.id)).filter((p) => p.id !== itemId);
    const beforeId = uuid(body.before_id ?? body.beforeId);
    const afterId = uuid(body.after_id ?? body.afterId);
    const before = beforeId ? (pending.find((p) => p.id === beforeId)?.sort ?? null) : null;
    const after = afterId ? (pending.find((p) => p.id === afterId)?.sort ?? null) : null;
    if (before == null && after == null && pending.length) {
      return bad("Could not work out where to put that song.");
    }

    await setQueueItemSortByGuest(sb, itemId, midpointSort(before, after));
    return NextResponse.json({ ok: true, moved: itemId });
  } catch (err) {
    console.error("[jukebox:reorder]", err);
    return bad("Could not move that song.", 500);
  }
}
