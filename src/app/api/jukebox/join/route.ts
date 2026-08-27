// POST /api/jukebox/join — a guest scans the code and takes a seat.
//
// Joining is deliberately free of any sign-in. The seat is an httpOnly cookie,
// so the guest cannot hand their identity to somebody else by pasting a value
// out of devtools, and a ban actually sticks.
import { NextRequest, NextResponse } from "next/server";
import { sanitizeDisplayName } from "@/lib/jukebox";
import { createGuest, isIpBanned, issueGuestToken, loadQueue, renameGuest, setGuestBanned } from "@/lib/jukebox-db";
import { getAuthUser } from "@/lib/sj-admin-auth";
import {
  bad,
  clientIp,
  publicGuest,
  publicJukebox,
  rateLimited,
  resolveRoom,
  setGuestCookie,
  tooMany,
} from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ctx = await resolveRoom(req, body.code);
    if ("error" in ctx) return ctx.error;
    const { sb, jukebox } = ctx;

    const asked = sanitizeDisplayName(body.name);
    // Names are always required. Existing anonymous seats from the older
    // optional-name behavior are upgraded in place once the visitor answers.
    if (ctx.guest) {
      if (!(ctx.guest.display_name ?? "").trim()) {
        if (!asked) return NextResponse.json({ ok: false, needsName: true, jukebox: publicJukebox(jukebox) });
        await renameGuest(sb, ctx.guest.id, asked);
        ctx.guest.display_name = asked;
      }
      const queue = await loadQueue(sb, jukebox.id);
      return NextResponse.json({
        ok: true,
        jukebox: publicJukebox(jukebox),
        guest: publicGuest(ctx.guest),
        queue,
      });
    }

    const ip = clientIp(req);
    if (rateLimited(`join:${ip}`, 20)) return tooMany();

    if (!asked) {
      return NextResponse.json({
        ok: false,
        needsName: true,
        jukebox: publicJukebox(jukebox),
      });
    }

    // Null, not a generated name. The room calls them Listener <n> until they
    // decide otherwise, which is honest about which of the two it is.
    const displayName = asked;
    const { raw, hash } = issueGuestToken();

    // If they happen to be signed in, remember it so their name can follow
    // them to another device later. Sign-in is never required.
    const user = await getAuthUser(req).catch(() => null);

    const guest = await createGuest(sb, {
      jukeboxId: jukebox.id,
      displayName,
      tokenHash: hash,
      ip,
      userId: user?.id ?? null,
      userEmail: user?.email ?? null,
    });
    if (await isIpBanned(sb, jukebox.id, ip)) {
      await setGuestBanned(sb, guest.id, true);
      guest.is_banned = true;
    }

    const queue = await loadQueue(sb, jukebox.id);
    const res = NextResponse.json({
      ok: true,
      jukebox: publicJukebox(jukebox),
      guest: publicGuest(guest),
      queue,
    });
    setGuestCookie(res, jukebox.code, raw);
    return res;
  } catch (err) {
    console.error("[jukebox:join]", err);
    return bad("Could not join that jukebox.", 500);
  }
}
