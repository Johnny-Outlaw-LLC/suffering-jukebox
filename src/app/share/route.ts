// Johnny Outlaw, LLC — Suffering Jukebox — index of every chart page.
// One crawlable hub linking to all /share/<slug> pages.
import { NextResponse } from "next/server";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { listSharedSlugs, getShareImages, shareImageUrl } from "@/lib/share-images";

export const runtime = "nodejs";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export async function GET() {
  const slugs = await listSharedSlugs();

  let artists: Array<{ name: string; slug: string }> = [];
  try {
    const r = await fetch(
      `${REST}/artists?slug=not.is.null&select=name,slug&order=name.asc&limit=1000`,
      {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
        next: { revalidate: 3600 },
      },
    );
    if (r.ok) artists = await r.json();
  } catch {
    /* fall through to slugs only */
  }

  const nameFor = new Map(artists.map((a) => [a.slug, a.name]));
  const listed = slugs
    .map((slug) => ({ slug, name: nameFor.get(slug) || slug }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // One OG thumbnail per card. Fetched in parallel, and a miss just drops the
  // image rather than the card.
  const thumbs = new Map<string, string>();
  await Promise.all(
    listed.map(async ({ slug }) => {
      const imgs = await getShareImages(slug);
      const og = imgs.find((i) => i.format === "og");
      if (og) thumbs.set(slug, shareImageUrl(og));
    }),
  );

  const title = `Album charts for ${listed.length} artists | ${SITE_NAME}`;
  const desc = `Every artist on ${SITE_NAME} charted by YouTube plays, regenerated nightly. Browse the charts, then press play.`;

  const cards = listed
    .map(
      ({ slug, name }) => `<a class="card" href="${esc(SITE_URL)}/share/${esc(slug)}">
  ${
    thumbs.has(slug)
      ? `<img src="${esc(thumbs.get(slug)!)}" alt="${esc(`${name} album chart`)}" loading="lazy"
      decoding="async" width="1200" height="630">`
      : `<div class="noimg"></div>`
  }
  <span class="nm">${esc(name)}</span>
</a>`,
    )
    .join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description: desc,
    url: `${SITE_URL}/share`,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: listed.length,
      itemListElement: listed.map(({ slug, name }, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name,
        url: `${SITE_URL}/share/${slug}`,
      })),
    },
  };

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(SITE_URL)}/share">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:url" content="${esc(SITE_URL)}/share">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  :root { --bg:#0a0a0a; --card:#111; --border:#222; --text:#f0f0f0; --muted:#9a9a9a;
    --accent:#ff6b35; --violet:#9b7bb8; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:Inter,system-ui,sans-serif;
    line-height:1.55; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1180px; margin:0 auto; padding:2.5rem 1.25rem 5rem; }
  .mark { font-size:.78rem; font-weight:800; letter-spacing:.16em; color:var(--violet);
    text-decoration:none; display:inline-block; }
  h1 { font-size:clamp(1.8rem,5vw,2.8rem); font-weight:800; line-height:1.06; margin:.7rem 0 .5rem;
    letter-spacing:-.015em; }
  .lede { color:var(--muted); max-width:62ch; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:1.1rem;
    margin-top:2.5rem; }
  .card { text-decoration:none; color:var(--text); border:1px solid var(--border);
    border-radius:12px; overflow:hidden; background:var(--card); display:block;
    transition:border-color .15s; }
  .card:hover { border-color:var(--accent); }
  .card img, .card .noimg { display:block; width:100%; height:auto; aspect-ratio:1200/630;
    background:#050505; object-fit:cover; }
  .card .nm { display:block; padding:.7rem .85rem; font-weight:600; font-size:.95rem; }
  footer.btm { margin-top:3.5rem; padding-top:1.75rem; border-top:1px solid var(--border);
    color:var(--muted); font-size:.85rem; }
  footer.btm a { color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <a class="mark" href="${esc(SITE_URL)}/">SUFFERING JUKEBOX</a>
  <h1>Album charts</h1>
  <p class="lede">${esc(desc)}</p>
  <div class="grid">${cards}</div>
  <footer class="btm">
    <p>Charts are generated from public YouTube view counts and refresh nightly.</p>
    <p style="margin-top:.6rem"><a href="${esc(SITE_URL)}/">Back to ${esc(SITE_NAME)}</a></p>
  </footer>
</div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600, s-maxage=1800, stale-while-revalidate=86400",
    },
  });
}
