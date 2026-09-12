// Playlist vanity pages — /p/my-mix
// Share Link only (no nightly export images). Prefix keeps these clear of
// artist slugs (/pavement) and Online Jukebox vanity (/outlaw).
import { NextRequest, NextResponse } from "next/server";
import { readPublicHtml } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";
import { applySurfaceHead } from "@/lib/surface-head";
import {
  buildPlaylistCatalogHtml,
  buildPlaylistJsonLd,
  fetchPlaylistTracks,
  playlistPageDescription,
  type SeoPlaylist,
} from "@/lib/playlist-seo";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const surface = currentSurface(req.headers.get("host"));
  const home = `${surface.url}/${req.nextUrl.search}`;
  const { slug: raw } = await params;
  const slug = (raw || "").toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) {
    return NextResponse.redirect(home, 302);
  }

  const sb = createSjServiceClient();
  const { data: pl, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("playlists")
    .select("id,name,slug,user_name,user_email,is_public,visibility")
    .ilike("slug", slug)
    .maybeSingle();
  if (error || !pl) {
    return NextResponse.redirect(home, 302);
  }

  const isPublic = !!pl.is_public || pl.visibility === "public";
  const seoPl: SeoPlaylist = {
    id: pl.id,
    name: (pl.name || "Playlist").trim(),
    slug: (pl.slug || slug).toLowerCase(),
    user_name: pl.user_name,
  };
  const tracks = isPublic ? await fetchPlaylistTracks(seoPl.id) : [];
  const by = (seoPl.user_name || "").trim();
  const title = `${seoPl.name} Playlist — ${surface.name}`;
  const desc = playlistPageDescription(seoPl.name, by, tracks.length);
  const pageUrl = `${surface.url}/p/${seoPl.slug}`;

  let html = applySurfaceHead(readPublicHtml("index.html"), surface, {
    title,
    description: desc,
    keywords: `${seoPl.name}, playlist, ${by}, free online playlist, music playlist, ${surface.name}`,
    url: pageUrl,
    canonical: pageUrl,
    ...(isPublic ? { jsonLd: buildPlaylistJsonLd(seoPl, tracks, pageUrl) } : {}),
    robots: isPublic
      ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
      : "noindex, nofollow",
    extraHead: `<script>window.__PLAYLIST_PAGE__=${JSON.stringify({
      id: pl.id,
      name: pl.name,
      slug: seoPl.slug,
      isPublic,
    })}</script>\n`,
  });

  if (isPublic && tracks.length) {
    const catalogHtml = buildPlaylistCatalogHtml(seoPl, tracks, pageUrl);
    if (html.includes("</main>")) {
      html = html.replace("</main>", `</main>\n${catalogHtml}\n`);
    } else {
      html = html.replace("</body>", `${catalogHtml}\n</body>`);
    }
  }

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": isPublic
        ? "public, s-maxage=300, stale-while-revalidate=3600"
        : "private, no-store",
    },
  });
}
