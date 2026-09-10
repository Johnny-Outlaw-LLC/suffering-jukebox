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
  const raw = injectHeadExtras(readPublicHtml(...parts));
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
