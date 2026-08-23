import { NextRequest, NextResponse } from "next/server";
import { ownerMyJukebox } from "@/lib/my-jukebox";
import { searchYouTubeVideos } from "@/lib/sj-admin-auth";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await ownerMyJukebox(req);
    if (!ctx) return bad("Sign in to search YouTube for My Jukebox.", 401);
    if (rateLimited(`my-jukebox-search:${clientIp(req)}`, 20)) return tooMany();
    const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    if (query.length < 2) return NextResponse.json({ ok: true, results: [] });
    return NextResponse.json({ ok: true, results: await searchYouTubeVideos(query) });
  } catch (error) {
    console.error("[my-jukebox:search]", error);
    return bad("Could not search YouTube right now.", 502);
  }
}
