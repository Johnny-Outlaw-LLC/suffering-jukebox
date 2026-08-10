import { NextRequest, NextResponse } from "next/server";
import { SJ_SUPABASE_URL } from "@/lib/sj-admin-auth";

export const runtime = "edge";

/**
 * Same-origin CDN front for public jukebox-audio.
 * Browsers hit sufferingjukebox.stream (Vercel edge / any Cloudflare in front)
 * instead of supabase.co on every play, so repeat listens stay cheap.
 * Supports Range requests for seeking.
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
      // Cache at the edge between origin fetches
      next: { revalidate: 86400 * 30 },
    } as RequestInit);
  } catch (e) {
    console.error("[sj-audio] fetch", e);
    return NextResponse.json({ ok: false, error: "Upstream error." }, { status: 502 });
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return new NextResponse(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        "Cache-Control": "public, max-age=60",
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
  // Long-lived CDN cache — audio objects are immutable by path (timestamped filenames)
  out.set("Cache-Control", "public, max-age=31536000, immutable");
  out.set("CDN-Cache-Control", "public, max-age=31536000");
  out.set("Vercel-CDN-Cache-Control", "public, max-age=31536000");
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
