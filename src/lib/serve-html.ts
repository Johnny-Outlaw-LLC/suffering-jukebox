import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { currentSurface, type Surface } from "@/lib/surface";
import { applySurfaceHead, type HeadOverrides } from "@/lib/surface-head";

function injectHeadExtras(html: string) {
  const verification = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  if (!verification) return html;
  const tag = `<meta name="google-site-verification" content="${verification}">`;
  if (html.includes("google-site-verification")) return html;
  return html.replace("</head>", `  ${tag}\n</head>`);
}

/**
 * Crawlable brand blurb for Suffering Jukebox only. Kept out of
 * public/index.html so Listening Party never inherits it, and so the
 * dashboard brand-leak test stays honest. Clipped for listeners via the
 * existing #sj-seo-home CSS; left in the DOM for search engines.
 */
function sjHomeSeoBlurb(surface: Surface): string {
  if (surface.id !== "sj") return "";
  const u = surface.url;
  return (
    `<section id="sj-seo-home" class="sj-seo-catalog" aria-label="About ${surface.name}">` +
    `<h1>${surface.name}</h1>` +
    `<p>${surface.name} is the free website and online music player at ` +
    `<a href="${u}/">${surface.host}</a>. ` +
    `Stream 170+ artists with lyrics, ratings, and playlists. The name comes from ` +
    `the Silver Jews song &ldquo;Suffering Jukebox&rdquo;; this site is the app, ` +
    `not the track. No account is required to listen.</p>` +
    `<p>Start with the <a href="/about">About ${surface.name}</a> page, ` +
    `the <a href="/silver-jews">Silver Jews jukebox</a>, ` +
    `or the <a href="/purple-mountains">Purple Mountains</a> player.</p>` +
    `</section>\n`
  );
}

function injectHomeSeo(html: string, surface: Surface, enabled: boolean): string {
  if (!enabled) return html;
  const blurb = sjHomeSeoBlurb(surface);
  if (!blurb || html.includes('id="sj-seo-home"')) return html;
  return html.replace("<body>", `<body>\n${blurb}`);
}

export function readPublicHtml(...parts: string[]) {
  return readFileSync(join(process.cwd(), "public", ...parts), "utf-8");
}

export interface ServeOptions {
  /** Host header, so preview and local hosts resolve to the right brand. */
  host?: string | null;
  /** Per-page head overrides. Sub-pages with their own titles pass none. */
  overrides?: HeadOverrides;
  /** Response headers to merge over the defaults. */
  headers?: Record<string, string>;
  /**
   * Inject the crawlable Suffering Jukebox brand blurb after <body>.
   * Only the real home page should set this.
   */
  homeSeo?: boolean;
}

/**
 * Serve a file from public/ as the brand this request arrived on.
 *
 * Every page goes through applySurfaceHead, which is what lets one copy of
 * index.html serve both Suffering Jukebox and Listening Party. For SJ the
 * rewrite is an identity, so this changes nothing about what it serves.
 */
export function servePublicHtmlFor(
  surface: Surface,
  parts: string[],
  opts: Omit<ServeOptions, "host"> = {}
) {
  const raw = injectHomeSeo(
    injectHeadExtras(readPublicHtml(...parts)),
    surface,
    !!opts.homeSeo
  );
  const html = applySurfaceHead(raw, surface, opts.overrides);
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(opts.headers || {}),
    },
  });
}

export function servePublicHtml(...parts: string[]) {
  return servePublicHtmlFor(currentSurface(), parts);
}
