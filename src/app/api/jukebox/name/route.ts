// POST /api/jukebox/name — a guest names themselves.
//
// There is no GET any more. It used to hand back a nickname lifted out of a
// lyric for a "shuffle my name" button; guests are numbered until they choose
// something now, and a name is never invented for them.
import { NextRequest, NextResponse } from "next/server";
import { sanitizeDisplayName } from "@/lib/jukebox";
import { renameGuest } from "@/lib/jukebox-db";
import { bad, clientIp, publicGuest, rateLimited, resolveRoom, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ctx = await resolveRoom(req, body.code);
    if ("error" in ctx) return ctx.error;
    const { sb, guest } = ctx;

    if (rateLimited(`rename:${clientIp(req)}`, 20)) return tooMany();
    if (!guest) return bad("Join the jukebox first.", 401);
    if (guest.is_banned) return bad("You can no longer take part in this jukebox.", 403);

    const name = sanitizeDisplayName(body.name);
    if (!name) return bad("Pick a name with at least one character in it.");

    await renameGuest(sb, guest.id, name);
    return NextResponse.json({
      ok: true,
      guest: publicGuest({ ...guest, display_name: name }),
    });
  } catch (err) {
    console.error("[jukebox:name]", err);
    return bad("Could not change your name.", 500);
  }
}
