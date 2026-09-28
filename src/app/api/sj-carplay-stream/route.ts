import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/artist-rights";
import { createB2DownloadUrl, sisterB2RedirectUrl } from "@/lib/b2-audio";
import { createSjServiceClient } from "@/lib/sj-admin-auth";
import { CARPLAY_URL_SECONDS, carKeyUser, carplayStoragePath } from "@/lib/carplay-library";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

/// A fresh signed URL for one song, asked for by the phone at the moment the
/// car starts it. Resolving late is the whole point: a URL handed over when
/// the web view was last awake would have expired by the drive.
export async function GET(req: NextRequest) {
  const trackId = req.nextUrl.searchParams.get("track_id") || "";
  if (!isUuid(trackId)) return noStore({ ok: false, error: "Invalid track." }, 400);
  const sister = sisterB2RedirectUrl(req.nextUrl.host, req.nextUrl.pathname + req.nextUrl.search);
  if (sister) {
    return NextResponse.redirect(new URL(sister), {
      status: 307, headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
  try {
    const sb = createSjServiceClient();
    const userId = await carKeyUser(sb, req);
    const path = await carplayStoragePath(sb, trackId, userId);
    if (!path) return noStore({ ok: false, error: "Not available in CarPlay." }, 404);
    const url = await createB2DownloadUrl(path, CARPLAY_URL_SECONDS);
    return noStore({ ok: true, url, expiresIn: CARPLAY_URL_SECONDS });
  } catch (error) {
    console.error("[sj-carplay-stream]", error);
    return noStore({ ok: false, error: "Could not authorize audio." }, 500);
  }
}
