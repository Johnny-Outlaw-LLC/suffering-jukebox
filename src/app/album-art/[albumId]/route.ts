// Public album covers uploaded via Manage Album. Bucket is private; this
// route is the only way out, keyed by album id (never an arbitrary B2 path).
import { NextRequest, NextResponse } from "next/server";
import { createB2DownloadUrl } from "@/lib/b2-audio";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ albumId: string }> },
) {
  const { albumId: raw } = await params;
  const albumId = (raw || "").replace(/\.jpe?g$/i, "").toLowerCase();
  if (!UUID.test(albumId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sb = createSjServiceClient();
  const { data: album } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id,art_url")
    .eq("id", albumId)
    .maybeSingle();
  if (!album) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Only serve when the row points at this route — stops using the path as a
  // generic B2 reader for albums that never uploaded a cover.
  const art = String(album.art_url || "");
  if (!art.includes(`/album-art/${albumId}`)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const signed = await createB2DownloadUrl(`album-art/${albumId}.jpg`, 60 * 60);
    const upstream = await fetch(signed, { signal: AbortSignal.timeout(20000) });
    if (!upstream.ok) {
      return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    console.error("[album-art]", e);
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  }
}
