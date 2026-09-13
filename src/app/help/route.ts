import type { NextRequest } from "next/server";
import { serveSurfacePage } from "@/lib/serve-html";

// Each brand has its own guide. Token-swapping the Suffering Jukebox one would
// leave artist-jukebox sections that do not exist on Listening Party.
export async function GET(req: NextRequest) {
  return serveSurfacePage(req.headers.get("host"), "help");
}
