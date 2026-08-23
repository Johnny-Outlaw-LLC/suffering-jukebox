// POST /api/jukebox/name — a guest changes the name that shows on the TV.
//
// Also serves GET, which hands back a fresh lyric-derived suggestion for the
// "shuffle my name" button.
import { NextRequest, NextResponse } from "next/server";
import { sanitizeDisplayName } from "@/lib/jukebox";
import { renameGuest, sjb, suggestGuestName } from "@/lib/jukebox-db";
import { bad, clientIp, publicGuest, rateLimited, resolveRoom, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (rateLimited(`suggest:${clientIp(req)}`, 40)) return tooMany();
  return NextResponse.json({ ok: true, suggestion: await suggestGuestName(sjb()) });
}

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
