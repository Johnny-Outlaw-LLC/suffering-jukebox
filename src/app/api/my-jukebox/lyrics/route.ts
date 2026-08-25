import { NextRequest, NextResponse } from "next/server";
import { ownerMyJukebox } from "@/lib/my-jukebox";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { lrclibLookup, plainFrom } from "@/lib/lrclib";

export const dynamic = "force-dynamic";

const MAX = 20;
const CONCURRENCY = 4;

// The last step of the Spotify wizard: the songs are in, now go and find the
// words. Same source and same rules as an artist import - LRCLIB, plain text
// into jukebox.lyrics, the timed .lrc onto tracks.lyrics_synced when there is
// one. Nothing here fails the import: a song with no lyrics is still a song.
export async function POST(req: NextRequest) {
  try {
    const ctx = await ownerMyJukebox(req);
    if (!ctx) return bad("Sign in to finish importing.", 401);
    if (rateLimited(`my-jukebox-lyrics:${clientIp(req)}`, 30)) return tooMany();

    const body = (await req.json().catch(() => ({}))) as { trackIds?: string[] };
    const ids = (Array.isArray(body.trackIds) ? body.trackIds : [])
      .filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, MAX);
    if (!ids.length) return NextResponse.json({ ok: true, checked: 0, found: 0, synced: 0 });

    const sb = ctx.sb.schema(JUKEBOX_SCHEMA);
    const { data: rows, error } = await sb
      .from("tracks")
      .select("id,name,duration_ms,lyrics_synced,albums!inner(artists!inner(name))")
      .in("id", ids);
    if (error) throw error;

    const tracks = (rows ?? []) as Array<{ id: string; name: string; duration_ms: number | null; lyrics_synced: string | null; albums?: { artists?: { name?: string } } }>;
    const { data: have } = await sb.from("lyrics").select("track_id").in("track_id", tracks.map((t) => t.id));
    const already = new Set((have ?? []).map((r: any) => r.track_id as string));
    const todo = tracks.filter((t) => !already.has(t.id));

    let found = 0;
    let synced = 0;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (track) => {
        try {
          const artist = track.albums?.artists?.name || "";
          const hit = await lrclibLookup(artist, track.name, track.duration_ms ? track.duration_ms / 1000 : null);
          if (!hit) return;
          const plain = plainFrom(hit);
          if (plain) {
            await sb.from("lyrics").insert({ track_id: track.id, lyrics: plain, lyrics_source: "lrclib", lyrics_saved_at: new Date().toISOString() });
            found += 1;
          }
          if (hit.synced && !track.lyrics_synced) {
            await sb.from("tracks").update({ lyrics_synced: hit.synced }).eq("id", track.id);
            synced += 1;
          }
        } catch { /* a song without words is still a song */ }
      }));
    }
    return NextResponse.json({ ok: true, checked: todo.length, found, synced, alreadyHad: tracks.length - todo.length });
  } catch (error) {
    console.error("[my-jukebox:lyrics]", error);
    return bad("Could not look up lyrics for those songs.", 502);
  }
}
