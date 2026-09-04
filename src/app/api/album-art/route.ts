// Upload a resized album cover into B2 and point albums.art_url at /album-art/<id>.
import { NextRequest, NextResponse } from "next/server";
import { putB2Object } from "@/lib/b2-audio";
import {
  createSjServiceClient,
  getAuthUser,
  isSjAdmin,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFICIAL_MANAGE_SLUGS = new Set(["silver-jews", "purple-mountains"]);
const OFFICIAL_OWNER = "johnnyoutlawllc@gmail.com";
const MAX_BYTES = 400 * 1024;
const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

function albumArtKey(albumId: string) {
  return `album-art/${albumId}.jpg`;
}

function publicArtPath(albumId: string) {
  // Cache-bust so a re-upload replaces the broken/old cover in every tab.
  return `/album-art/${albumId}?v=${Date.now()}`;
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) return bad("Sign in required.", 401);

  let body: { album_id?: string; image?: string };
  try {
    body = await req.json();
  } catch {
    return bad("Invalid request.");
  }

  const albumId = typeof body.album_id === "string" ? body.album_id.trim() : "";
  if (!UUID.test(albumId)) return bad("Invalid album.");

  const image = typeof body.image === "string" ? body.image.trim() : "";
  const m = image.match(DATA_URL_RE);
  if (!m) return bad("Upload a JPEG, PNG or WebP image.");

  let buf: Buffer;
  try {
    buf = Buffer.from(image.slice(m[0].length), "base64");
  } catch {
    return bad("That image could not be read.");
  }
  if (!buf.length || buf.length > MAX_BYTES) {
    return bad("That image is too large. Try a smaller file.");
  }

  const sb = createSjServiceClient();
  const { data: album } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id,artist_id,added_by")
    .eq("id", albumId)
    .maybeSingle();
  if (!album?.artist_id) return bad("Album not found.", 404);

  const { data: artist } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id,slug,added_by")
    .eq("id", album.artist_id)
    .maybeSingle();
  if (!artist) return bad("Album not found.", 404);

  const email = user.email.toLowerCase();
  const admin = await isSjAdmin(user.email);
  const owns =
    (album.added_by || "").toLowerCase() === email ||
    (artist.added_by || "").toLowerCase() === email ||
    (OFFICIAL_MANAGE_SLUGS.has(artist.slug || "") && email === OFFICIAL_OWNER);
  if (!admin && !owns) {
    return bad("You can only change covers on music you imported.", 403);
  }

  try {
    await putB2Object(albumArtKey(albumId), buf, "image/jpeg");
  } catch (e) {
    console.error("[album-art] put", e);
    return bad("Could not store the cover right now.", 500);
  }

  const artUrl = publicArtPath(albumId);
  const { error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .update({ art_url: artUrl })
    .eq("id", albumId);
  if (error) {
    console.error("[album-art] update", error);
    return bad("Cover uploaded but the album row could not be updated.", 500);
  }

  return NextResponse.json({ ok: true, art_url: artUrl });
}
