import { NextRequest, NextResponse } from "next/server";
import { ownerMyJukebox } from "@/lib/my-jukebox";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import {
  resolveCandidate, resolveCatalogIndex, resolvePrivateIndexFor,
  type MatchCandidate,
} from "@/lib/catalog-index";

export const dynamic = "force-dynamic";

const MAX = 300;

// Which track in the Jukebox is this audio file?
//
// The per-artist and per-playlist batch uploaders already answer a narrower
// version of this in the browser, because there the pool is one album's worth
// of names. A folder off somebody's hard drive has no scope at all: the answer
// has to be found in the whole catalogue, which is 5,000+ tracks and is not
// going down the wire to do it. So the browser sends what it read out of each
// file - ID3 tags, or the Artist/Album/Title shape of the path - and gets back
// one track id per file, or null.
//
// Nothing is written here. The reply is a proposal the listener reviews before
// a single byte is uploaded, which is what makes a loose match acceptable: a
// wrong row gets corrected on screen rather than silently attached.
export async function POST(req: NextRequest) {
  try {
    const ctx = await ownerMyJukebox(req);
    if (!ctx) return bad("Sign in to match your audio files.", 401);
    if (rateLimited(`my-jukebox-match-audio:${clientIp(req)}`, 40)) return tooMany();

    const body = (await req.json().catch(() => ({}))) as { tracks?: MatchCandidate[] };
    const candidates = Array.isArray(body.tracks) ? body.tracks.slice(0, MAX) : [];
    if (!candidates.length) return NextResponse.json({ ok: true, matches: [] });

    // Same two halves the picker uses: the shared catalogue, plus the private
    // artists this listener imported. Library rows are deliberately not a
    // source here - a library row is not a catalogue track and has no track id
    // to hang an upload on.
    const [shared, mine] = await Promise.all([
      resolveCatalogIndex(ctx.sb),
      resolvePrivateIndexFor(ctx.sb, ctx.user.email),
    ]);

    const indexes = [shared, mine];
    const matches = candidates.map((candidate) => resolveCandidate(indexes, candidate || {}));
    return NextResponse.json({ ok: true, matches });
  } catch (error) {
    console.error("[my-jukebox:match-audio]", error);
    return bad("Could not match these files to the Jukebox.", 502);
  }
}
