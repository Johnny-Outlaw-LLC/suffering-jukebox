import { NextRequest, NextResponse } from "next/server";
import { SJ_SUPABASE_URL } from "@/lib/sj-admin-auth";

export const runtime = "edge";

/**
 * Same-origin front for public jukebox-audio.
 *
 * IMPORTANT: HTML5 <audio> seeking (and most mobile play starts) send Range
 * requests and need a real 206 + Content-Range. Caching a full-body 200 at the
 * CDN and then answering Range with that cached 200 makes playback go silent
 * the moment we hand off from YouTube mid-track. So:
 *  - Range requests always hit Supabase with cache: "no-store"
 *  - Vercel CDN is told not to store these responses (browser may still cache)
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: parts } = await ctx.params;
  const path = (parts || []).map(encodeURIComponent).join("/");
  if (!path || path.includes("..")) {
    return NextResponse.json({ ok: false, error: "Bad path." }, { status: 400 });
  }

  const upstream = `${SJ_SUPABASE_URL}/storage/v1/object/public/jukebox-audio/${path}`;
  const range = req.headers.get("range");
  const headers: HeadersInit = {
    Accept: req.headers.get("accept") || "*/*",
  };
  if (range) headers.Range = range;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      headers,
      // Never reuse a full-body Next fetch cache for a Range request — that
      // returns status 200 without Content-Range and breaks <audio>.
      cache: "no-store",
    });
  } catch (e) {
    console.error("[sj-audio] fetch", e);
    return NextResponse.json({ ok: false, error: "Upstream error." }, { status: 502 });
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        "Cache-Control": "public, max-age=60",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    });
  }

  const out = new Headers();
  const pass = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const h of pass) {
    const v = upstreamRes.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has("accept-ranges")) out.set("Accept-Ranges", "bytes");
  out.set("Vary", "Range");
  // Browser can keep a copy; do not let the Vercel CDN store a full 200 that
  // later answers Range incorrectly (that was the silent-handoff bug).
  out.set("Cache-Control", "public, max-age=31536000, immutable");
  out.set("CDN-Cache-Control", "no-store");
  out.set("Vercel-CDN-Cache-Control", "no-store");
  out.set("Access-Control-Allow-Origin", "*");
  out.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    headers: out,
  });
}

export async function HEAD(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const res = await GET(req, ctx);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
