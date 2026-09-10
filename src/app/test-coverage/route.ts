import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

/**
 * The admin Test Coverage page.
 *
 * Served by hand rather than through servePublicHtml because the page needs one
 * thing the static file cannot know: the commit this deployment was built from.
 * public/test-results.json records the commit the tests were RUN against, and
 * the only interesting question about a green page is whether those two are the
 * same code. Stamping the deploy sha here lets the page answer it.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const file = join(process.cwd(), "public", "test-coverage", "index.html");
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GIT_COMMIT_SHA?.trim() ||
    "";
  const html = readFileSync(file, "utf-8").replace(
    "<html lang=\"en\">",
    `<html lang="en" data-deploy-sha="${sha.replace(/[^a-f0-9]/gi, "")}">`,
  );
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
