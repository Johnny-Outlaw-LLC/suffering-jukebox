// GET /api/jukebox/qr?code=XXXXXX — the code a guest scans.
//
// Served as SVG so it prints sharply at any size on a table card, and so the
// host console can drop it straight into an <img> with no encoder shipped to
// the browser.
import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { normalizeCode } from "@/lib/jukebox";
import { SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

/** The address printed on the card. Short on purpose: people retype it. */
export function jukeboxJoinUrl(code: string): string {
  return `${SITE_URL}/j/${code.toUpperCase()}`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = normalizeCode(url.searchParams.get("code") ?? "");
  if (!code) {
    return NextResponse.json({ ok: false, error: "Bad code." }, { status: 400 });
  }

  const dark = url.searchParams.get("dark") === "1";
  const svg = await QRCode.toString(jukeboxJoinUrl(code), {
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
      // The code never changes for a room, so let it cache hard.
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
