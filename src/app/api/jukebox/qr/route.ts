// GET /api/jukebox/qr?code=XXXXXX — the code a guest scans.
//
// Served as SVG so it prints sharply at any size on a table card, and so the
// host console can drop it straight into an <img> with no encoder shipped to
// the browser.
import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { normalizeRoomKey } from "@/lib/jukebox";
import { getJukeboxByKey, sjb } from "@/lib/jukebox-db";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * The address printed on the card. A room that has picked a vanity address
 * gets that one, because /outlaw is what somebody can retype from across the
 * room and /j/ZPGZ4H is not.
 */
export function jukeboxJoinUrl(room: { code: string; public_slug?: string | null }): string {
  return room.public_slug ? `${SITE_URL}/${room.public_slug}` : `${SITE_URL}/j/${room.code.toUpperCase()}`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const key = normalizeRoomKey(url.searchParams.get("code") ?? "");
  if (!key) {
    return NextResponse.json({ ok: false, error: "Bad code." }, { status: 400 });
  }
  const room = await getJukeboxByKey(sjb(), key).catch(() => null);
  if (!room) {
    return NextResponse.json({ ok: false, error: "No jukebox at that address." }, { status: 404 });
  }

  const dark = url.searchParams.get("dark") === "1";
  const svg = await QRCode.toString(jukeboxJoinUrl(room), {
    type: "svg",
    errorCorrectionLevel: "M",
    // A quiet zone of 2 rather than the default 4: the card art supplies the
    // surrounding whitespace, and 4 wastes a lot of a small printed square.
    margin: 2,
    color: dark
      ? { dark: "#f5f5f5ff", light: "#0a0a0aff" }
      : { dark: "#0a0a0aff", light: "#ffffffff" },
  });

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // The address can change the moment an owner picks a vanity slug, so
      // this is cached for minutes rather than the day it used to be.
      "Cache-Control": "public, max-age=300",
    },
  });
}
