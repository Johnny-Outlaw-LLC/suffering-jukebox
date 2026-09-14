import type { NextRequest } from "next/server";
import { currentSurface } from "@/lib/surface";
import { buildLlmsTxt } from "@/lib/llms-txt";

export async function GET(req: NextRequest) {
  const surface = currentSurface(req.headers.get("host"));
  const body = buildLlmsTxt(surface);

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
