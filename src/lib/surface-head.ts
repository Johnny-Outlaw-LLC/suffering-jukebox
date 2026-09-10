// Johnny Outlaw, LLC — the one place that rewrites a served page's <head>.
//
// public/index.html is written as Suffering Jukebox: its title, metas and
// structured data all name that brand. Rather than keep a second copy of a
// 43,000 line file for Listening Party, every response passes through here and
// the SJ literals in the <head> are swapped for the serving surface's.
//
// Two rules keep this safe:
//
//   1. It only ever touches the <head>. The body carries the changelog, which
//      is history and says "Suffering Jukebox" because that is what happened.
//      A blanket replace across the document would rewrite the past.
//   2. For the SJ surface every substitution is an identity, so the bytes it
//      serves today are the bytes it served before this file existed.
//
// /[slug] artist pages layer their own title, description and JSON-LD on top
// through `overrides`, which is why that route no longer hand-rolls its own
// chain of .replace() calls.

import { publicSurface, type Surface } from "@/lib/surface";

export interface HeadOverrides {
  title?: string;
  description?: string;
  /**
   * og: and twitter: descriptions, which on the home page are deliberately
   * shorter than the meta description rather than a copy of it. They fall back
   * to `description` when a caller has only one sentence to give.
   */
  ogDescription?: string;
  twitterDescription?: string;
  keywords?: string;
  /** Page URL for og:url. */
  url?: string;
  /**
   * Emits <link rel="canonical">. Separate from `url` on purpose: artist pages
   * want one and the home page has never had one, and quietly adding it would
   * be an SEO change smuggled in under a rebrand.
   */
  canonical?: string;
  /** Absolute image URL for og:image / twitter:image. */
  image?: string;
  /** Replaces the first application/ld+json block. */
  jsonLd?: Record<string, unknown> | null;
  robots?: string;
  /** Raw markup inserted immediately before </head>. */
  extraHead?: string;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Longest first: the www URL has to go before the bare host it contains, and
 * favicon.png before favicon-32.png would corrupt the latter.
 *
 * Every entry is an identity for Suffering Jukebox, so its served bytes are
 * unchanged by this file existing.
 */
function brandTokens(s: Surface): [string, string][] {
  const a = s.assetBase;
  return [
    // The social card is named outright rather than derived from assetBase:
    // a brand may not have a 1200x630 card of its own yet, and Surface.ogImage
    // is the single place that decides what it uses instead.
    ["https://www.sufferingjukebox.stream/og-image.png", s.ogImage],
    ["https://www.sufferingjukebox.stream", s.url],
    ["https://sufferingjukebox.stream", s.url],
    ["sufferingjukebox.stream", s.host],
    ["Suffering Jukebox", s.name],
    ["/suffering-jukebox-text-logo.png", s.textLogo],
    // Anchored on href= on purpose. A bare "/favicon.png" also appears inside
    // the og:image once a brand points that at its icon, and rewriting it a
    // second time would nest the asset prefix into itself.
    ['href="/favicon-32.png"', `href="${a}/favicon-32.png"`],
    ['href="/favicon.png"', `href="${a}/favicon.png"`],
  ];
}

function replaceAll(hay: string, find: string, put: string): string {
  return find === put ? hay : hay.split(find).join(put);
}

function setMeta(head: string, attr: "name" | "property", key: string, value: string): string {
  const re = new RegExp(`<meta ${attr}="${key}" content="[^"]*">`);
  const tag = `<meta ${attr}="${key}" content="${esc(value)}">`;
  return re.test(head) ? head.replace(re, tag) : head;
}

/**
 * Rewrite `html`'s head for `surface`, applying any per-page overrides, and
 * publish the surface to the browser as window.__SURFACE__.
 *
 * Pages with their own titles (Help, About, the legal pages) pass no
 * overrides: token substitution alone turns "Help — Suffering Jukebox" into
 * "Help — Listening Party" without this function needing to know the page.
 */
export function applySurfaceHead(
  html: string,
  surface: Surface,
  overrides: HeadOverrides = {}
): string {
  const cut = html.indexOf("</head>");
  if (cut === -1) return html;

  let head = html.slice(0, cut);
  const rest = html.slice(cut);

  for (const [find, put] of brandTokens(surface)) head = replaceAll(head, find, put);

  head = setMeta(head, "name", "theme-color", surface.themeColor);
  // The declared card size has to describe the file actually being served, or
  // a scraper lays out a wide card and is handed a small square.
  head = setMeta(head, "property", "og:image:width", String(surface.ogImageSize.w));
  head = setMeta(head, "property", "og:image:height", String(surface.ogImageSize.h));

  if (overrides.title) {
    head = head.replace(/<title>[^<]*<\/title>/, `<title>${esc(overrides.title)}</title>`);
    head = setMeta(head, "property", "og:title", overrides.title);
    head = setMeta(head, "name", "twitter:title", overrides.title);
  }
  if (overrides.description) {
    head = setMeta(head, "name", "description", overrides.description);
  }
  const og = overrides.ogDescription ?? overrides.description;
  if (og) head = setMeta(head, "property", "og:description", og);
  const tw = overrides.twitterDescription ?? overrides.description;
  if (tw) head = setMeta(head, "name", "twitter:description", tw);
  if (overrides.keywords) head = setMeta(head, "name", "keywords", overrides.keywords);
  if (overrides.url) head = setMeta(head, "property", "og:url", overrides.url);
  if (overrides.image) {
    head = setMeta(head, "property", "og:image", overrides.image);
    head = setMeta(head, "name", "twitter:image", overrides.image);
  }
  if (overrides.robots) head = setMeta(head, "name", "robots", overrides.robots);

  if (overrides.jsonLd) {
    head = head.replace(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      `<script type="application/ld+json">${JSON.stringify(overrides.jsonLd)}</script>`
    );
  }

  // The dashboard is a classic script that reads this at startup, so it has to
  // be defined before it and JSON.stringify keeps it inert markup either way.
  const inject =
    `<script>window.__SURFACE__=${JSON.stringify(publicSurface(surface)).replace(
      /</g,
      "\\u003c"
    )}</script>\n` +
    (overrides.canonical ? `<link rel="canonical" href="${esc(overrides.canonical)}">\n` : "") +
    (overrides.extraHead || "");

  return `${head}${inject}${rest}`;
}
