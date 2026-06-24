import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

export function servePublicHtml(...parts: string[]) {
  const filePath = join(process.cwd(), "public", ...parts);
  const html = readFileSync(filePath, "utf-8");
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
