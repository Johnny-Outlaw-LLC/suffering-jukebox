// Johnny Outlaw, LLC — Suffering Jukebox — public, indexable chart pages.
//
// A bare PNG on a CDN essentially never ranks. Images get found when they sit
// on a crawlable page with real text around them, so every artist's nightly
// charts get a page here: captioned, described, dated, and linked straight back
// to the player so a search result turns into a listen.
import { NextRequest, NextResponse } from "next/server";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import {
  getShareImages,
  shareImageUrl,
  SHOT_LABELS,
  SHOT_ORDER,
  type ShareImage,
} from "@/lib/share-images";

export const runtime = "nodejs";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;

const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const SHOT_BLURB: Record<string, (n: string) => string> = {
  "byyear-collapsed": (n) => `Every ${n} album in release order, each bar sized by YouTube plays.`,
  "byviews-collapsed": (n) => `The same ${n} catalog reordered most played to least.`,
  "timeline-collapsed": (n) => `${n}'s releases spaced across an actual time axis.`,
  "byyear-expanded": (n) => `Every ${n} album opened up to the individual tracks underneath.`,
  alltracks: (n) => `Every ${n} track in one sortable table, ranked by plays.`,
};

async function sb<T>(path: string, revalidate = 900): Promise<T[]> {
  try {
    const r = await fetch(`${REST}${path}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
      next: { revalidate },
    });
    if (!r.ok) return [];
    return (await r.json()) as T[];
  } catch {
    return [];
  }
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/Chicago",
    });
  } catch {
    return "";
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug: raw } = await params;
  const slug = (raw || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return NextResponse.redirect(`${SITE_URL}/`, 302);

  const [artist] = await sb<{ id: string; name: string; slug: string }>(
    `/artists?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug`,
  );
  if (!artist) return NextResponse.redirect(`${SITE_URL}/`, 302);

  const images = await getShareImages(slug);
  // Nothing captured yet (a brand new artist before the next nightly run):
  // send people to the player rather than showing an empty page.
  if (!images.length) return NextResponse.redirect(`${SITE_URL}/${slug}`, 302);

  const byShot = new Map<string, ShareImage[]>();
  for (const img of images) {
    if (!byShot.has(img.shot_id)) byShot.set(img.shot_id, []);
    byShot.get(img.shot_id)!.push(img);
  }
  const og = images.find((i) => i.format === "og") || null;
  const first = images[0];
  const name = (artist.name || "").trim();
  const albums = first.album_count || 0;
  const trackTotal = first.track_count || 0;
  const updated = images
    .map((i) => i.captured_at)
    .sort()
    .reverse()[0];

  const playUrl = `${SITE_URL}/${slug}`;
  const pageUrl = `${SITE_URL}/share/${slug}`;
  const title = `${name} album charts, updated ${fmtDate(updated)} | ${SITE_NAME}`;
  const desc =
    `Charts of every ${name} album ranked by YouTube plays` +
    (albums ? ` — ${albums} album${albums === 1 ? "" : "s"}` : "") +
    (trackTotal ? `, ${trackTotal} tracks` : "") +
    `. Regenerated nightly. Press play on any track at ${SITE_NAME}.`;

  const ordered = SHOT_ORDER.filter((id) => byShot.has(id)).concat(
    [...byShot.keys()].filter((id) => !SHOT_ORDER.includes(id)),
  );

  const sections = ordered
    .map((shotId) => {
      const group = byShot.get(shotId)!;
      const stage = group.find((g) => g.format === "stage");
      const reel = group.find((g) => g.format === "reel");
      if (!stage) return "";
      const label = SHOT_LABELS[shotId] || shotId;
      const blurb = SHOT_BLURB[shotId]?.(name) || `The ${name} jukebox, ${label} view.`;
      const alt = `${name} ${label} chart — every album ranked by YouTube plays on ${SITE_NAME}`;
      const reelLink = reel
        ? `<a class="dl" href="${esc(shareImageUrl(reel))}" download>Story / reel version (1080&times;1920)</a>`
        : "";
      return `<section class="shot" id="${esc(shotId)}">
  <h2>${esc(name)} &mdash; ${esc(label)}</h2>
  <p class="blurb">${esc(blurb)}</p>
  <a class="shot-img" href="${esc(shareImageUrl(stage))}" target="_blank" rel="noopener">
    <img src="${esc(shareImageUrl(stage))}" alt="${esc(alt)}" loading="lazy" decoding="async"
      ${stage.width ? `width="${stage.width}"` : ""} ${stage.height ? `height="${stage.height}"` : ""}/>
  </a>
  <p class="shot-foot">
    <a class="play" href="${esc(playUrl)}">Open this view and play it &rarr;</a>
    ${reelLink}
  </p>
</section>`;
    })
    .join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "MusicGroup",
        name,
        url: playUrl,
        ...(og ? { image: shareImageUrl(og) } : {}),
      },
      {
        "@type": "CollectionPage",
        name: title,
        description: desc,
        url: pageUrl,
        isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
        dateModified: updated,
        about: { "@type": "MusicGroup", name, url: playUrl },
        hasPart: ordered
          .map((shotId) => {
            const stage = byShot.get(shotId)?.find((g) => g.format === "stage");
            if (!stage) return null;
            const label = SHOT_LABELS[shotId] || shotId;
            return {
              "@type": "ImageObject",
              contentUrl: shareImageUrl(stage),
              name: `${name} — ${label}`,
              description: SHOT_BLURB[shotId]?.(name) || label,
              ...(stage.width ? { width: stage.width } : {}),
              ...(stage.height ? { height: stage.height } : {}),
              uploadDate: stage.captured_at,
              creditText: SITE_NAME,
              acquireLicensePage: pageUrl,
            };
          })
          .filter(Boolean),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Charts", item: `${SITE_URL}/share` },
          { "@type": "ListItem", position: 3, name, item: pageUrl },
        ],
      },
    ],
  };

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(pageUrl)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${og ? `<meta property="og:image" content="${esc(shareImageUrl(og))}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(`${name} album chart from ${SITE_NAME}`)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${og ? `<meta name="twitter:image" content="${esc(shareImageUrl(og))}">` : ""}
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
  a { color:var(--accent); }
  header.top { border-bottom:1px solid var(--border); padding-bottom:1.75rem; margin-bottom:2.25rem; }
  .mark { font-size:.78rem; font-weight:800; letter-spacing:.16em; color:var(--violet);
    text-decoration:none; display:inline-block; }
  h1 { font-size:clamp(1.85rem,5vw,3rem); font-weight:800; line-height:1.05; margin:.7rem 0 .55rem;
    letter-spacing:-.015em; }
  .lede { color:var(--muted); font-size:1.02rem; max-width:62ch; }
  .facts { display:flex; flex-wrap:wrap; gap:.5rem; margin-top:1.1rem; }
  .fact { font-size:.78rem; color:var(--muted); border:1px solid var(--border);
    border-radius:999px; padding:.3rem .75rem; }
  .cta-row { margin-top:1.5rem; display:flex; flex-wrap:wrap; gap:.7rem; }
  .btn { display:inline-block; background:var(--accent); color:#150800; font-weight:600;
    text-decoration:none; padding:.7rem 1.15rem; border-radius:8px; font-size:.94rem; }
  .btn.ghost { background:none; color:var(--text); border:1px solid var(--border); }
  .hero { margin:2.25rem 0 1rem; border:1px solid var(--border); border-radius:14px;
    overflow:hidden; background:var(--card); }
  .hero img { display:block; width:100%; height:auto; }
  section.shot { margin-top:3rem; }
  section.shot h2 { font-size:1.22rem; font-weight:700; letter-spacing:-.01em; }
  .blurb { color:var(--muted); font-size:.95rem; margin:.35rem 0 .9rem; max-width:66ch; }
  .shot-img { display:block; border:1px solid var(--border); border-radius:12px;
    background:var(--card); overflow-x:auto; }
  .shot-img img { display:block; width:100%; height:auto; }
  .shot-foot { margin-top:.7rem; display:flex; flex-wrap:wrap; gap:1.1rem; font-size:.88rem; }
  .play { font-weight:600; text-decoration:none; }
  .play:hover { text-decoration:underline; }
  .dl { color:var(--muted); text-decoration:none; }
  .dl:hover { color:var(--text); }
  footer.btm { margin-top:4rem; padding-top:1.75rem; border-top:1px solid var(--border);
    color:var(--muted); font-size:.85rem; }
  footer.btm a { color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="mark" href="${esc(SITE_URL)}/">SUFFERING JUKEBOX</a>
    <h1>${esc(name)} album charts</h1>
    <p class="lede">${esc(desc)}</p>
    <div class="facts">
      ${albums ? `<span class="fact">${albums} album${albums === 1 ? "" : "s"}</span>` : ""}
      ${trackTotal ? `<span class="fact">${trackTotal} tracks</span>` : ""}
      <span class="fact">Updated ${esc(fmtDate(updated))}</span>
      <span class="fact">Regenerated nightly</span>
    </div>
    <div class="cta-row">
      <a class="btn" href="${esc(playUrl)}">Play the ${esc(name)} jukebox</a>
      <a class="btn ghost" href="${esc(SITE_URL)}/share">All artists</a>
    </div>
  </header>

  ${og ? `<div class="hero"><img src="${esc(shareImageUrl(og))}" width="1200" height="630"
    alt="${esc(`${name} album chart card from ${SITE_NAME}`)}"></div>` : ""}

  ${sections}

  <footer class="btm">
    <p>These charts are generated automatically from public YouTube view counts and refresh every
    night, so the numbers here track the live ones in the player. Album artwork belongs to its
    respective rights holders.</p>
    <p style="margin-top:.6rem">
      <a href="${esc(playUrl)}">${esc(name)} jukebox</a> &middot;
      <a href="${esc(SITE_URL)}/share">All chart pages</a> &middot;
      <a href="${esc(SITE_URL)}/">${esc(SITE_NAME)}</a>
    </p>
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
