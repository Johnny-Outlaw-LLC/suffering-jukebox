import type { NextRequest } from "next/server";
import { servePublicHtmlFor } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";

export async function GET(req: NextRequest) {
  const surface = currentSurface(req.headers.get("host"));
  // Listening Party gets its own help page. Token-swapping the Suffering
  // Jukebox guide would leave artist-jukebox sections that do not exist here.
  const parts =
    surface.id === "lp"
      ? (["help", "lp", "index.html"] as string[])
      : (["help", "index.html"] as string[]);
  return servePublicHtmlFor(surface, parts);
}
