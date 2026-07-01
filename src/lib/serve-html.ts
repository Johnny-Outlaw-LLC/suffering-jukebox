import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

function injectHeadExtras(html: string) {
  const verification = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  if (!verification) return html;
  const tag = `<meta name="google-site-verification" content="${verification}">`;
  if (html.includes("google-site-verification")) return html;
  return html.replace("</head>", `  ${tag}\n</head>`);
}

export function servePublicHtml(...parts: string[]) {
  const filePath = join(process.cwd(), "public", ...parts);
  const html = injectHeadExtras(readFileSync(filePath, "utf-8"));
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
