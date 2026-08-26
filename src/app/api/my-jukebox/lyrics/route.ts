import { NextRequest, NextResponse } from "next/server";
import { ownerMyJukebox } from "@/lib/my-jukebox";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { attachLyricsForTrack } from "@/lib/single-import";

export const dynamic = "force-dynamic";
// A Spotify pass can be fifteen songs; each one may need two LRCLIB calls.
// Without this the Hobby default (~10s) cuts the batch off mid-way, which is
// exactly how a full import landed with almost no lyrics on 2026-08-25.
export const maxDuration = 60;

const MAX = 40;
const CONCURRENCY = 3;

// Backfill / retry for songs that somehow missed the inline lookup during
// import. Same source and same rules as an artist import - LRCLIB, plain text
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

    const tracks = (rows ?? []) as Array<{
      id: string;
      name: string;
      duration_ms: number | null;
      lyrics_synced: string | null;
      albums?: { artists?: { name?: string } };
    }>;
    const { data: have } = await sb.from("lyrics").select("track_id").in("track_id", tracks.map((t) => t.id));
    const already = new Set((have ?? []).map((r: any) => r.track_id as string));
    const todo = tracks.filter((t) => !already.has(t.id) || !t.lyrics_synced);

    let found = 0;
    let synced = 0;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (track) => {
        try {
          const artist = track.albums?.artists?.name || "";
          const result = await attachLyricsForTrack(
            ctx.sb,
            track.id,
            artist,
            track.name,
            track.duration_ms,
          );
          if (result.found && !already.has(track.id)) found += 1;
          if (result.synced && !track.lyrics_synced) synced += 1;
        } catch { /* a song without words is still a song */ }
      }));
    }
    return NextResponse.json({ ok: true, checked: todo.length, found, synced, alreadyHad: tracks.length - todo.length });
  } catch (error) {
    console.error("[my-jukebox:lyrics]", error);
    return bad("Could not look up lyrics for those songs.", 502);
  }
}
