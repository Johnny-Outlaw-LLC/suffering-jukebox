import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/artist-rights";
import { createSjServiceClient, JUKEBOX_SCHEMA, verifySjAdmin } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  const sb = createSjServiceClient();
  const [{ data: artists, error: artistError }, { data: grants, error: grantError }] = await Promise.all([
    sb.schema(JUKEBOX_SCHEMA).from("artists").select("id,name").order("name").limit(1000),
    sb.schema(JUKEBOX_SCHEMA).from("artist_upload_grants")
      .select("artist_id,user_email,limit_bytes,created_at").order("created_at", { ascending: false }),
  ]);
  if (artistError || grantError) return NextResponse.json({ ok: false, error: "Could not load artist upload grants." }, { status: 500 });
  return NextResponse.json({ ok: true, artists, grants }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const artistId = String(body.artistId || "");
  const email = String(body.email || "").trim().toLowerCase();
  const gib = Number(body.gib || 10);
  if (!isUuid(artistId) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      !Number.isInteger(gib) || gib < 1 || gib > 50) {
    return NextResponse.json({ ok: false, error: "Choose an artist, verified account email, and 1–50 GB." }, { status: 400 });
  }
  const sb = createSjServiceClient();
  const { data: artist, error: artistError } = await sb.schema(JUKEBOX_SCHEMA)
    .from("artists").select("id").eq("id", artistId).maybeSingle();
  if (artistError || !artist) return NextResponse.json({ ok: false, error: "Artist not found." }, { status: 404 });
  const { error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_grants")
    .upsert({ artist_id: artistId, user_email: email, limit_bytes: gib * 1024 ** 3,
      granted_by: auth.user.id }, { onConflict: "artist_id,user_email" });
  if (error) {
    console.error("[artist-upload-grants]", error);
    return NextResponse.json({ ok: false, error: "Could not grant upload capacity." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 }); }
  const artistId = String(body.artistId || "");
  const email = String(body.email || "").trim().toLowerCase();
  if (!isUuid(artistId) || !email) return NextResponse.json({ ok: false, error: "Invalid grant." }, { status: 400 });
  const sb = createSjServiceClient();
  const { error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_grants")
    .delete().eq("artist_id", artistId).eq("user_email", email);
  if (error) return NextResponse.json({ ok: false, error: "Could not remove upload grant." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
