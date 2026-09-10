// Johnny Outlaw, LLC — indexable artist jukebox pages (/pavement)
// Serves the SPA shell with artist-specific meta, MusicGroup JSON-LD, and a
// crawlable HTML catalog (song titles + lyrics as real text) so search engines
// and AI crawlers can find the artist and the words — not only a Loading… div.
//
// Only surfaces that lead with artists have these pages. Listening Party leads
// with playlists and has no artist view to land on, so it sends the visitor
// home rather than rendering a page whose navigation does not exist.
import { NextRequest, NextResponse } from "next/server";
import { readPublicHtml } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";
import { applySurfaceHead } from "@/lib/surface-head";
import { getOgImage, shareImageUrl } from "@/lib/share-images";
import {
  artistPageDescription,
  buildArtistCatalogHtml,
  buildArtistJsonLd,
  fetchArtistCatalog,
  fetchPublicArtistBySlug,
} from "@/lib/artist-seo";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const surface = currentSurface(req.headers.get("host"));
  // Keep the query string on redirects so a shared-link ?s= still hydrates
  // on the main page even when the artist slug no longer resolves.
  const home = `${surface.url}/${req.nextUrl.search}`;
  if (!surface.features.artistPages) return NextResponse.redirect(home, 302);

  const { slug: raw } = await params;
  const slug = (raw || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
    return NextResponse.redirect(home, 302);
  }

  const artist = await fetchPublicArtistBySlug(slug);
  if (!artist) {
    return NextResponse.redirect(home, 302);
  }

  // Social preview: prefer the nightly 1200x630 chart card, which shows what
  // this site actually does. Album art is the fallback for an artist added
  // since the last capture run; the generic site image is the last resort.
  let art = "";
  if (surface.features.shareImages) {
    try {
      const card = await getOgImage(artist.slug);
      if (card) art = shareImageUrl(card);
    } catch {
      /* album art below */
    }
  }
  if (!art) {
    try {
      const r = await fetch(
        `https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1/albums?artist_id=eq.${artist.id}&select=art_url&order=release_date.asc&limit=8`,
        {
          headers: {
            apikey:
              "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ",
            Authorization:
              "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ",
            "Accept-Profile": "jukebox",
          },
          next: { revalidate: 3600 },
        }
      );
      if (r.ok) {
        const albs = await r.json();
        art = (albs || []).map((a: { art_url?: string }) => a.art_url).find(Boolean) || "";
      }
    } catch {
      /* generic og:image below */
    }
  }

  const catalog = await fetchArtistCatalog(artist.id);
  const name = (artist.name || "").trim();
  const title = `${name} Jukebox — Free Online Music Player | ${surface.name}`;
  const desc = artistPageDescription(name, catalog.tracks.length, catalog.albums.length);
  const pageUrl = `${surface.url}/${artist.slug}`;
  const jsonLd = buildArtistJsonLd(artist, catalog, pageUrl);
  const catalogHtml = buildArtistCatalogHtml(artist, catalog, pageUrl);

  let html = applySurfaceHead(readPublicHtml("index.html"), surface, {
    title,
    description: desc,
    keywords: `${name}, ${name} jukebox, ${name} lyrics, ${name} songs, free online music player, free jukebox, stream ${name}, ${surface.name}`,
    url: pageUrl,
    canonical: pageUrl,
    // Only override when we found one; otherwise the surface's own card, which
    // is already in the head, stands.
    image: art || undefined,
    // Drop the homepage WebApplication block; the artist graph replaces it.
    jsonLd,
    robots: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
    extraHead: `<script>window.__SLUG_ARTIST__=${JSON.stringify({
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
    })}</script>\n`,
  });

  // Catalog text after </main> so crawlers see titles + lyrics. CSS clips it
  // for JS listeners from the first paint; the SPA also sets [hidden] once up.
  if (html.includes("</main>")) {
    html = html.replace("</main>", `</main>\n${catalogHtml}\n`);
  } else {
    html = html.replace("</body>", `${catalogHtml}\n</body>`);
  }

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Hourly edge cache — catalog text does not need to be live every request.
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
