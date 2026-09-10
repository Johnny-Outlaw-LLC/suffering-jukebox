// The listener-added artist view. Artist-shaped, so a playlist-led brand
// sends the visitor to its own front door rather than to a page whose
// navigation it does not have.
import { NextResponse } from "next/server";
import { servePublicHtml } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";

export async function GET() {
  const surface = currentSurface();
  if (!surface.features.artistJukebox) {
    return NextResponse.redirect(`${surface.url}/`, 302);
  }
  return servePublicHtml("index.html");
}
