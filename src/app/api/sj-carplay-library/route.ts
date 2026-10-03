import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient } from "@/lib/sj-admin-auth";
import { carKeyAccount, carKeyUser, carplayLibrary } from "@/lib/carplay-library";

export const dynamic = "force-dynamic";

/// Everything the car can stream: the key holder's own uploads plus every
/// artist-licensed song. No key still answers, with the licensed songs only.
/// `signedIn: false` while the phone sent a key means that key is dead (revoked
/// by a sign-out elsewhere), and the page issues a fresh one on next launch.
/// Metadata only - URLs are resolved one song at a time by /api/sj-carplay-stream.
export async function GET(req: NextRequest) {
  try {
    const sb = createSjServiceClient();
    const userId = await carKeyUser(sb, req);
    const [tracks, account] = await Promise.all([
      carplayLibrary(sb, userId, req.nextUrl.origin),
      userId ? carKeyAccount(sb, userId).catch(() => null) : null,
    ]);
    return NextResponse.json(
      { ok: true, signedIn: Boolean(userId), account, tracks },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[sj-carplay-library]", error);
    return NextResponse.json({ ok: false, error: "Could not load the CarPlay library." }, { status: 500 });
  }
}
