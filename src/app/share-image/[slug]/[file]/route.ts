// Johnny Outlaw, LLC — Suffering Jukebox — public share images.
//
// Serves the nightly-generated chart images from B2 under our own domain.
// The B2 bucket is private (the app key is scoped to it and cannot create a
// public one), and serving from sufferingjukebox.stream is what we want anyway:
// search engines attribute images to the domain that serves them.
//
// The key is never taken from the URL directly — it is looked up in
// jukebox.share_images, so this cannot be used to read arbitrary bucket objects.
import { NextRequest, NextResponse } from "next/server";
import { createB2DownloadUrl } from "@/lib/b2-audio";

export const runtime = "nodejs";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,79}\.png$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; file: string }> },
) {
  const { slug: rawSlug, file: rawFile } = await params;
  const slug = (rawSlug || "").toLowerCase();
  const file = (rawFile || "").toLowerCase();
  if (!SLUG_RE.test(slug) || !FILE_RE.test(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = `share/v1/${slug}/${file}`;

  // Confirm this is a key we actually published before touching the bucket.
  const lookup = await fetch(
    `${REST}/share_images?b2_key=eq.${encodeURIComponent(key)}&select=b2_key&limit=1`,
    {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
      next: { revalidate: 300 },
    },
  );
  const rows: Array<{ b2_key: string }> = lookup.ok ? await lookup.json() : [];
  if (!rows.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const signed = await createB2DownloadUrl(key, 60 * 60);
    const upstream = await fetch(signed, { signal: AbortSignal.timeout(20000) });
    if (!upstream.ok) {
      return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        // Content is replaced nightly at the same key, so cache at the CDN but
        // never permanently. The old day-long stale-while-revalidate window let
        // a re-captured image keep serving yesterday's picture long after the
        // job had replaced it, which is exactly what a re-capture is meant to
        // fix. Callers that need the newest file (the Export Image download)
        // also carry the capture stamp as a query param.
        "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    console.error("[share-image]", e);
    return NextResponse.json({ error: "Fetch failed" }, { status: 502 });
  }
}
