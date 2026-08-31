// Playlist vanity pages — /p/my-mix
// Share Link only (no nightly export images). Prefix keeps these clear of
// artist slugs (/pavement) and Online Jukebox vanity (/outlaw).
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

function esc(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const home = `${SITE_URL}/${req.nextUrl.search}`;
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
  const name = (pl.name || "Playlist").trim();
  const by = (pl.user_name || "").trim();
  const title = `${name} Playlist — ${SITE_NAME}`;
  const desc = by
    ? `Listen to ${name} by ${by} on ${SITE_NAME}, a free online music player and jukebox.`
    : `Listen to ${name} on ${SITE_NAME}, a free online music player and jukebox.`;
  const pageUrl = `${SITE_URL}/p/${(pl.slug || slug).toLowerCase()}`;

  let html = readFileSync(join(process.cwd(), "public", "index.html"), "utf-8");
  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${esc(desc)}">`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${esc(pageUrl)}">`,
    )
    .replace(
      /<meta property="og:title" content="[^"]*">/,
      `<meta property="og:title" content="${esc(title)}">`,
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${esc(desc)}">`,
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*">/,
      `<meta name="twitter:title" content="${esc(title)}">`,
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*">/,
      `<meta name="twitter:description" content="${esc(desc)}">`,
    );

  const robots = isPublic
    ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
    : "noindex, nofollow";

  const inject =
    `<link rel="canonical" href="${esc(pageUrl)}">\n` +
    `<meta name="robots" content="${robots}">\n` +
    `<script>window.__PLAYLIST_PAGE__=${JSON.stringify({
      id: pl.id,
      name: pl.name,
      slug: (pl.slug || slug).toLowerCase(),
      isPublic,
    })}</script>\n`;
  html = html.replace("</head>", `${inject}</head>`);

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": isPublic
        ? "public, s-maxage=300, stale-while-revalidate=3600"
        : "private, no-store",
    },
  });
}
