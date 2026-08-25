import { NextRequest, NextResponse } from "next/server";
import { ownerMyJukebox, loadLibrary } from "@/lib/my-jukebox";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { addToIndex, catalogIndex, emptyIndex, indexHas, privateIndexFor } from "@/lib/catalog-index";

export const dynamic = "force-dynamic";

const MAX = 500;

// Answers one question about a batch of candidate songs: is this already in
// the Jukebox? Both halves count - the shared catalogue everybody can play,
// and the listener's own library rows, which may hold a song no artist import
// ever brought in.
export async function POST(req: NextRequest) {
  try {
    const ctx = await ownerMyJukebox(req);
    if (!ctx) return bad("Sign in to check your music.", 401);
    if (rateLimited(`my-jukebox-known:${clientIp(req)}`, 60)) return tooMany();

    const body = (await req.json().catch(() => ({}))) as { tracks?: Array<{ title?: string; artist?: string }> };
    const candidates = Array.isArray(body.tracks) ? body.tracks.slice(0, MAX) : [];
    if (!candidates.length) return NextResponse.json({ ok: true, known: [] });

    // Three sources, in order of how many people they answer for: the public
    // catalogue, the private artists this listener imported, and their own
    // library rows for anything that never became a catalogue artist.
    const [shared, mine, library] = await Promise.all([
      catalogIndex(ctx.sb),
      privateIndexFor(ctx.sb, ctx.user.email),
      loadLibrary(ctx.sb, ctx.jukebox.id),
    ]);
    const own = emptyIndex();
    library.forEach((item) => addToIndex(own, item.title, item.artistName));

    const indexes = [shared, mine, own];
    const known: number[] = [];
    candidates.forEach((candidate, n) => {
      if (indexHas(indexes, candidate?.title || "", candidate?.artist || "")) known.push(n);
    });
    return NextResponse.json({ ok: true, known });
  } catch (error) {
    console.error("[my-jukebox:known]", error);
    return bad("Could not check what is already in the Jukebox.", 502);
  }
}
