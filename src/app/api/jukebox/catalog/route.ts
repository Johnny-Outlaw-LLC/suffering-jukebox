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

      // Title-only search made "Tool" and "Windser" look empty: guests type the
      // band, and the song names do not contain it. Hit title, artist and album
      // in parallel, artist/album first so the band they asked for leads.
      const pattern = `%${safe}%`;
      const trackSelect =
        "id,name,duration_ms,explicit,visibility,artist_audio_visible,albums!inner(id,name,art_url,release_date,visibility,artist_audio_visible,artists!inner(id,name,slug,visibility,artist_audio_visible))";
      const base = () =>
        sb.schema(JUKEBOX_SCHEMA).from("tracks").select(trackSelect)
          .eq("visibility", "public").eq("artist_audio_visible", true)
          .order("name", { ascending: true }).limit(SEARCH_LIMIT);

      const [byArtist, byAlbum, byTitle] = await Promise.all([
        base().ilike("albums.artists.name", pattern),
        base().ilike("albums.name", pattern),
        base().ilike("name", pattern),
      ]);
      if (byArtist.error) throw byArtist.error;
      if (byAlbum.error) throw byAlbum.error;
      if (byTitle.error) throw byTitle.error;

      const seen = new Set<string>();
      const merged: any[] = [];
      for (const row of [...(byArtist.data ?? []), ...(byAlbum.data ?? []), ...(byTitle.data ?? [])]) {
        if (!isPublicTrack(row) || seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
        if (merged.length >= SEARCH_LIMIT) break;
      }
      return NextResponse.json({ ok: true, mode: "search", results: merged.map(shapeTrack) });
    }

    if (artistId) {
      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("albums")
        .select("id,name,art_url,release_date,color,visibility,artist_audio_visible,artists!inner(id,name,slug,visibility,artist_audio_visible),tracks(id,name,track_number,disc_number,duration_ms,explicit,visibility,artist_audio_visible)")
        .eq("artist_id", artistId)
        .eq("visibility", "public").eq("artist_audio_visible", true)
        .order("release_date", { ascending: true })
        .limit(100);
      if (error) throw error;

      const albums = (data ?? []).filter((a: any) =>
        a.artists?.visibility === "public" && a.artists?.artist_audio_visible === true,
      ).map((a: any) => ({
        id: a.id,
        name: a.name,
        art: a.art_url,
        year: a.release_date ? String(a.release_date).slice(0, 4) : null,
        color: a.color,
        artistName: a.artists?.name ?? null,
        tracks: (a.tracks ?? [])
          .filter((t: any) => t.visibility === "public" && t.artist_audio_visible === true)
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
        .select("id,name,duration_ms,explicit,visibility,artist_audio_visible,albums!inner(id,name,art_url,release_date,visibility,artist_audio_visible,artists!inner(id,name,slug,visibility,artist_audio_visible))")
        .eq("visibility", "public").eq("artist_audio_visible", true)
        .order("name", { ascending: true })
        .limit(PLAYLIST_LIMIT);
      if (error) throw error;
      return NextResponse.json({ ok: true, mode: "playlist", tracks: (data ?? []).filter(isPublicTrack).map(shapeTrack) });
    }

    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id,name,slug,color")
      .eq("visibility", "public").eq("artist_audio_visible", true)
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw error;
    return NextResponse.json({ ok: true, mode: "artists", artists: data ?? [] });
  } catch (err) {
    console.error("[jukebox:catalog]", err);
    return bad("Could not load the collection.", 500);
  }
}

function isPublicTrack(t: any): boolean {
  return !!t?.id && t.visibility === "public" && t.artist_audio_visible === true &&
    t.albums?.visibility === "public" && t.albums?.artist_audio_visible === true &&
    t.albums?.artists?.visibility === "public" && t.albums?.artists?.artist_audio_visible === true;
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
