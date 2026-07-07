// Johnny Outlaw, LLC — Suffering Jukebox — shared playlist links (/s/SLUG)
// Serves OG/Twitter meta so links unfurl nicely, then bounces humans to /?s=SLUG
// where the app hydrates the shared queue.
import { NextRequest, NextResponse } from "next/server";
import { SITE_NAME } from "@/lib/site";

export const dynamic = "force-dynamic";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!/^[A-Za-z0-9]{6,12}$/.test(slug)) {
    return NextResponse.redirect("https://sufferingjukebox.stream/", 302);
  }

  let name = "";
  let by = "";
  let count = 0;
  let thumb = "";
  try {
    const r = await fetch(
      `${REST}/shared_links?slug=eq.${slug}&select=name,shared_by,payload`,
      {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
        cache: "no-store",
      }
    );
    const rows = await r.json();
    const row = rows?.[0];
    if (row) {
      name = (row.name || "").trim();
      by = (row.shared_by || "").trim();
      const queue = Array.isArray(row.payload?.queue) ? row.payload.queue : [];
      count = queue.length;
      const idx = Math.min(Math.max(row.payload?.idx || 0, 0), Math.max(count - 1, 0));
      const vid = queue[idx]?.videoId || queue[0]?.videoId;
      if (vid) thumb = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    }
  } catch {
    /* fall through — serve generic tags */
  }

  const title = name ? `${name} — ${SITE_NAME}` : `A shared playlist — ${SITE_NAME}`;
  const desc = count
    ? `${by || "Someone"} shared ${count} track${count === 1 ? "" : "s"} of Silver Jews & Purple Mountains. Press play.`
    : "A shared Silver Jews & Purple Mountains playlist. Press play.";
  const dest = `https://sufferingjukebox.stream/?s=${slug}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="music.playlist">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="https://sufferingjukebox.stream/s/${slug}">
${thumb ? `<meta property="og:image" content="${esc(thumb)}">` : ""}
<meta name="twitter:card" content="${thumb ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${thumb ? `<meta name="twitter:image" content="${esc(thumb)}">` : ""}
<meta http-equiv="refresh" content="0;url=${dest}">
<script>location.replace(${JSON.stringify(dest)});</script>
<style>body{background:#0a0a0a;color:#888;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head>
<body><p>Opening your playlist… <a href="${dest}" style="color:#c9a227">tap here</a> if nothing happens.</p></body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
