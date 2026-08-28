// GET /api/jukebox/catalog — what a guest is allowed to browse.
//
// Served from the server rather than shipped to the phone. The dashboard loads
// the whole collection into the browser, which is fine on a laptop and wrong
// for somebody on bar wifi who wants to queue one song.
//
// Three modes on one route:
//   ?code=X                -> the artist list
//   ?code=X&artist=<id>    -> that artist's albums, with their tracks
//   ?code=X&q=<text>       -> track search across the collection
import { NextRequest, NextResponse } from "next/server";
import { JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { bad, clientIp, rateLimited, resolveRoom, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

const SEARCH_LIMIT = 60;
const PLAYLIST_LIMIT = 800;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    if (rateLimited(`catalog:${clientIp(req)}`, 120)) return tooMany();

    // Browsing still requires a real room, so the catalog cannot be scraped
    // through this route by someone who never scanned anything.
    const ctx = await resolveRoom(req, url.searchParams.get("code"));
    if ("error" in ctx) return ctx.error;
    const { sb } = ctx;

    const q = (url.searchParams.get("q") ?? "").trim();
    const artistId = url.searchParams.get("artist");
    const playlistView = url.searchParams.get("view") === "playlist";

    if (q) {
      if (q.length < 2) return NextResponse.json({ ok: true, mode: "search", results: [] });
      // PostgREST treats , and . as syntax inside or(), so they are stripped
      // rather than escaped; a song title search does not need them.
      const safe = q.replace(/[,.()*%]/g, " ").trim();
      if (!safe) return NextResponse.json({ ok: true, mode: "search", results: [] });

      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("id,name,duration_ms,explicit,albums!inner(id,name,art_url,release_date,artists!inner(id,name,slug))")
        .ilike("name", `%${safe}%`)
        .order("name", { ascending: true })
        .limit(SEARCH_LIMIT);
      if (error) throw error;
      return NextResponse.json({ ok: true, mode: "search", results: (data ?? []).map(shapeTrack) });
    }

    if (artistId) {
      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("albums")
        .select("id,name,art_url,release_date,color,artists!inner(id,name,slug),tracks(id,name,track_number,disc_number,duration_ms,explicit)")
        .eq("artist_id", artistId)
        .order("release_date", { ascending: true })
        .limit(100);
      if (error) throw error;

      const albums = (data ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
        art: a.art_url,
        year: a.release_date ? String(a.release_date).slice(0, 4) : null,
        color: a.color,
        artistName: a.artists?.name ?? null,
        tracks: (a.tracks ?? [])
          .sort(
            (x: any, y: any) =>
              (x.disc_number ?? 1) - (y.disc_number ?? 1) ||
              (x.track_number ?? 0) - (y.track_number ?? 0),
          )
          .map((t: any) => ({
            id: t.id,
            name: t.name,
            trackNumber: t.track_number,
            durationMs: t.duration_ms,
            explicit: !!t.explicit,
          })),
      }));
      return NextResponse.json({ ok: true, mode: "artist", albums });
    }

    // The room's Explore Playlist view needs one flat, addable song list.
    // Keep it deliberately capped: this runs on a phone in a room, not the
    // dashboard's exhaustive catalog browser.
    if (playlistView) {
      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .select("id,name,duration_ms,explicit,albums!inner(id,name,art_url,release_date,artists!inner(id,name,slug))")
        .order("name", { ascending: true })
        .limit(PLAYLIST_LIMIT);
      if (error) throw error;
      return NextResponse.json({ ok: true, mode: "playlist", tracks: (data ?? []).map(shapeTrack) });
    }

    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id,name,slug,color")
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({ ok: true, mode: "artists", artists: data ?? [] });
  } catch (err) {
    console.error("[jukebox:catalog]", err);
    return bad("Could not load the collection.", 500);
  }
}

function shapeTrack(t: any) {
  const album = t.albums ?? {};
  const artist = album.artists ?? {};
  return {
    id: t.id,
    name: t.name,
    durationMs: t.duration_ms,
    explicit: !!t.explicit,
    albumId: album.id ?? null,
    albumName: album.name ?? null,
    albumArt: album.art_url ?? null,
    year: album.release_date ? String(album.release_date).slice(0, 4) : null,
    artistId: artist.id ?? null,
    artistName: artist.name ?? null,
    artistSlug: artist.slug ?? null,
  };
}
