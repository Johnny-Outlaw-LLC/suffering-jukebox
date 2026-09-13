// Artist licensing for public mobile background play. A brand without it sends
// the visitor to its own front door rather than to a licence it does not offer.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { servePublicHtmlFor } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";

export async function GET(req: NextRequest) {
  const surface = currentSurface(req.headers.get("host"));
  if (!surface.features.artistUpload) {
    return NextResponse.redirect(`${surface.url}/`, 302);
  }
  return servePublicHtmlFor(surface, ["artist-agreement", "index.html"]);
}
