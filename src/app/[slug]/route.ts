// Johnny Outlaw, LLC — Suffering Jukebox — indexable artist jukebox pages (/pavement)
// Serves the SPA shell with artist-specific meta, MusicGroup JSON-LD, and a
// crawlable HTML catalog (song titles + lyrics as real text) so search engines
// and AI crawlers can find the artist and the words — not only a Loading… div.
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { getOgImage, shareImageUrl } from "@/lib/share-images";
import {
  artistPageDescription,
  buildArtistCatalogHtml,
  buildArtistJsonLd,
  esc,
  fetchArtistCatalog,
  fetchPublicArtistBySlug,
} from "@/lib/artist-seo";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  // Keep the query string on redirects so a shared-link ?s= still hydrates
  // on the main page even when the artist slug no longer resolves.
  const home = `${SITE_URL}/${req.nextUrl.search}`;
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
  try {
    const card = await getOgImage(artist.slug);
    if (card) art = shareImageUrl(card);
  } catch {
    /* album art below */
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
  const title = `${name} Jukebox — Free Online Music Player | ${SITE_NAME}`;
  const desc = artistPageDescription(name, catalog.tracks.length, catalog.albums.length);
  const pageUrl = `${SITE_URL}/${artist.slug}`;
  const jsonLd = buildArtistJsonLd(artist, catalog, pageUrl);
  const catalogHtml = buildArtistCatalogHtml(artist, catalog, pageUrl);

  let html = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${esc(desc)}">`
    )
    .replace(
      /<meta name="keywords" content="[^"]*">/,
      `<meta name="keywords" content="${esc(
        `${name}, ${name} jukebox, ${name} lyrics, ${name} songs, free online music player, free jukebox, stream ${name}, ${SITE_NAME}`
      )}">`
    )
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${esc(pageUrl)}">`
    )
    .replace(
      /<meta property="og:title" content="[^"]*">/,
      `<meta property="og:title" content="${esc(title)}">`
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${esc(desc)}">`
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*">/,
      `<meta name="twitter:title" content="${esc(title)}">`
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*">/,
      `<meta name="twitter:description" content="${esc(desc)}">`
    );

  // Drop the homepage Silver Jews WebApplication block; artist graph replaces it.
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
  );

  if (art) {
    html = html
      .replace(
        /<meta property="og:image" content="[^"]*">/,
        `<meta property="og:image" content="${esc(art)}">`
      )
      .replace(
        /<meta name="twitter:image" content="[^"]*">/,
        `<meta name="twitter:image" content="${esc(art)}">`
      );
  }

  const inject =
    `<link rel="canonical" href="${esc(pageUrl)}">\n` +
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">\n` +
    `<script>window.__SLUG_ARTIST__=${JSON.stringify({
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
    })}</script>\n`;
  html = html.replace("</head>", `${inject}</head>`);

  // Catalog text after </main> so crawlers see titles + lyrics; the SPA hides
  // #sj-seo-catalog once the interactive jukebox is up.
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
