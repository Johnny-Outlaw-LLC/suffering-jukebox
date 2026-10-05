// Share Song pages - /s/eason-know-it-all-<track uuid>
//
// Serves the ordinary app with a head that describes ONE song, so a link
// pasted into a chat previews as that song (title, artist, artwork), and
// injects window.__SONG_PAGE__ so the app opens the artist and plays it.
// A private song gets the brand's generic head - the link still plays for
// whoever can see it, but the preview never names it.
import { NextRequest, NextResponse } from "next/server";
import { readPublicHtml } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";
import { applySurfaceHead } from "@/lib/surface-head";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { songIdFromParam, songPath, songStartSeconds } from "@/lib/song-share";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string | null;
  visibility: string | null;
  album_id: string | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const surface = currentSurface(req.headers.get("host"));
  const home = `${surface.url}/`;
  const { id: raw } = await params;
  const id = songIdFromParam(raw);
  if (!id) return NextResponse.redirect(home, 302);
  const t = songStartSeconds(req.nextUrl.searchParams.get("t"));

  const sb = createSjServiceClient().schema(JUKEBOX_SCHEMA);
  const { data: track } = await sb
    .from("tracks")
    .select("id,name,visibility,album_id")
    .eq("id", id)
    .maybeSingle<Row>();
  if (!track) return NextResponse.redirect(home, 302);

  const { data: album } = track.album_id
    ? await sb
        .from("albums")
        .select("id,name,art_url,visibility,artist_id,release_date")
        .eq("id", track.album_id)
        .maybeSingle()
    : { data: null };
  const { data: artist } = album?.artist_id
    ? await sb
        .from("artists")
        .select("id,name,slug,visibility")
        .eq("id", album.artist_id)
        .maybeSingle()
    : { data: null };
  const { data: vids } = await sb
    .from("track_videos")
    .select("video_id,is_primary,is_playable")
    .eq("track_id", id)
    .order("is_primary", { ascending: false })
    .limit(5);

  const isPublic =
    track.visibility !== "private" &&
    album?.visibility !== "private" &&
    artist?.visibility !== "private";

  const title = (track.name || "Song").trim();
  const artistName = (artist?.name || "").trim();
  const albumName = (album?.name || "").trim();
  const pageUrl = `${surface.url}${songPath(artistName, title, id)}`;
  const videoId = (vids || []).find((v) => v.is_playable !== false)?.video_id || null;

  // Album art when we hold an absolute address for it, else the video's own
  // thumbnail. Only the thumbnail has a size we actually know.
  const art = typeof album?.art_url === "string" && /^https?:\/\//.test(album.art_url) ? album.art_url : null;
  const image = art || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

  const pageData = {
    id,
    t,
    artistId: artist?.id || null,
    artistSlug: artist?.slug || null,
    artistName: artistName || null,
  };
  const extraHead = `<script>window.__SONG_PAGE__=${JSON.stringify(pageData).replace(/</g, "\\u003c")}</script>\n`;

  const desc = artistName
    ? `"${title}" by ${artistName}${albumName && albumName !== "Singles" ? `, from ${albumName}` : ""}. Listen free on ${surface.name}.`
    : `"${title}". Listen free on ${surface.name}.`;

  const html = isPublic
    ? applySurfaceHead(readPublicHtml("index.html"), surface, {
        title: `${title}${artistName ? ` - ${artistName}` : ""} | ${surface.name}`,
        description: desc,
        url: pageUrl,
        canonical: pageUrl,
        ...(image ? { image, imageSize: art ? null : { w: 480, h: 360 } } : {}),
        robots: "index, follow, max-image-preview:large",
        extraHead,
      })
    : applySurfaceHead(readPublicHtml("index.html"), surface, {
        robots: "noindex, nofollow",
        extraHead,
      });

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": isPublic
        ? "public, s-maxage=300, stale-while-revalidate=3600"
        : "private, no-store",
    },
  });
}
