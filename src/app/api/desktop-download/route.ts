import { NextRequest, NextResponse } from "next/server";
import { currentSurface } from "@/lib/surface";
import { desktopDownloadUrl } from "@/lib/desktop-app";

export const dynamic = "force-dynamic";

// One stable address for "download the desktop app", so the page, the help
// copy and anything shared on the web never carry a version number.
export async function GET(req: NextRequest) {
  const surface = currentSurface(req.headers.get("host"));
  if (!surface.features.desktopApp) {
    return NextResponse.redirect(new URL("/", req.url), 302);
  }
  const platform = (req.nextUrl.searchParams.get("platform") || "windows").toLowerCase();
  const url = desktopDownloadUrl(platform);
  if (!url) {
    return NextResponse.json({ error: "That version of the desktop app is not available yet." }, { status: 404 });
  }
  return NextResponse.redirect(url, 302);
}
