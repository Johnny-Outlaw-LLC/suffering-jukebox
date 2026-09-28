import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient } from "@/lib/sj-admin-auth";
import { carKeyUser, carplayLibrary } from "@/lib/carplay-library";

export const dynamic = "force-dynamic";

/// Everything the car can stream: the key holder's own uploads plus every
/// artist-licensed song. No key still answers, with the licensed songs only.
/// Metadata only - URLs are resolved one song at a time by /api/sj-carplay-stream.
export async function GET(req: NextRequest) {
  try {
    const sb = createSjServiceClient();
    const userId = await carKeyUser(sb, req);
    const tracks = await carplayLibrary(sb, userId);
    return NextResponse.json(
      { ok: true, signedIn: Boolean(userId), tracks },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[sj-carplay-library]", error);
    return NextResponse.json({ ok: false, error: "Could not load the CarPlay library." }, { status: 500 });
  }
}
