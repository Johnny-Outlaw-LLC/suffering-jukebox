// Johnny Outlaw, LLC — Suffering Jukebox — share-friendly artist pages (/pavement)
// Looks up the artist by slug, serves the app HTML with artist-specific meta tags
// and window.__SLUG_ARTIST__ injected so the client renders that artist's jukebox.
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const dynamic = "force-dynamic";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function sb(path: string): Promise<any[]> {
  const r = await fetch(`${REST}${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
    cache: "no-store",
  });
  if (!r.ok) return [];
  return r.json();
}

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

  const [artist] = await sb(
    `/artists?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug,is_community,added_by_name`
  );
  if (!artist) {
    return NextResponse.redirect(home, 302);
  }
  // Main-catalog artists live on the home page
  if (!artist.is_community) {
    return NextResponse.redirect(home, 302);
  }

  let art = "";
  try {
    const albs = await sb(
      `/albums?artist_id=eq.${artist.id}&select=art_url&order=release_date.asc&limit=8`
    );
    art = albs.map((a: any) => a.art_url).find(Boolean) || "";
  } catch {
    /* generic og:image below */
  }

  const name = (artist.name || "").trim();
  const title = `${name} Jukebox | ${SITE_NAME}`;
  const desc = `An interactive ${name} jukebox — every album ranked by YouTube views. Stream the catalog, explore play history, press play.`;
  const pageUrl = `${SITE_URL}/${artist.slug}`;

  let html = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${esc(desc)}">`
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
    `<script>window.__SLUG_ARTIST__=${JSON.stringify({
      id: artist.id,
      name: artist.name,
      slug: artist.slug,
    })}</script>\n`;
  html = html.replace("</head>", `${inject}</head>`);

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
