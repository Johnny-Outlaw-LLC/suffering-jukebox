import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { sjb } from "@/lib/jukebox-db";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { parseIntake } from "@/lib/import-intake";
import { resolvePlaylist, resolveSongs, searchCatalog } from "@/lib/import-resolve";

export const dynamic = "force-dynamic";
// A long YouTube playlist walks several API pages in a row.
export const maxDuration = 60;

// The Add music box. One POST with whatever was typed or pasted; the reply says
// what it was and hands back rows that can be played straight away.
//
// Signing in is optional. A signed-out visitor can paste a link or a list and
// press play; they are asked to sign in only when they save something, or when
// songs we do not hold need a YouTube search (which costs quota). Reading a
// link or a playlist costs one YouTube unit per 50 videos, so it is fine here.
export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`import-intake:${clientIp(req)}`, 30)) return tooMany();
    const user = await getAuthUser(req).catch(() => null);
    const email = user?.email ?? null;
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    const intake = parseIntake(typeof body.text === "string" ? body.text : "");
    const sb = sjb();

    switch (intake.kind) {
      case "empty":
        return NextResponse.json({ ok: true, kind: "empty", reason: intake.reason });
      case "query": {
        const found = await searchCatalog(sb, email, intake.query);
        return NextResponse.json({ ok: true, kind: "query", query: intake.query, ...found });
      }
      case "songs": {
        const rows = await resolveSongs(sb, email, intake.songs);
        return NextResponse.json({ ok: true, kind: "songs", source: "list", rows, truncated: intake.truncated });
      }
      case "link": {
        const link = intake.link;
        if (link.type === "channel") return NextResponse.json({ ok: true, kind: "channel", url: link.url });
        if (link.type === "playlist") {
          const found = await resolvePlaylist(sb, link.playlistId);
          if (!found) return bad("That playlist could not be found. Check that it is public or unlisted.", 404);
          return NextResponse.json({ ok: true, kind: "songs", source: "playlist", ...found });
        }
        const rows = await resolveSongs(sb, email, [
          { line: link.videoId, artist: null, title: "", swappable: false, videoId: link.videoId },
        ]);
        return NextResponse.json({ ok: true, kind: "songs", source: "video", rows, playlistId: link.playlistId });
      }
    }
  } catch (error) {
    console.error("[import:intake]", error);
    return bad("Could not read that just now. Try again in a moment.", 502);
  }
}
