import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/artist-rights";
import { putB2Object } from "@/lib/b2-audio";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  try {
    const form = await req.formData();
    const releaseId = String(form.get("releaseId") || "");
    const file = form.get("art");
    if (!isUuid(releaseId) || !(file instanceof File) || file.size <= 0 || file.size > 5 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return NextResponse.json({ ok: false, error: "Use a JPEG, PNG, or WebP cover under 5 MB." }, { status: 400 });
    }
    const sb = createSjServiceClient();
    const { data: release, error: releaseError } = await sb.schema(JUKEBOX_SCHEMA)
      .from("artist_upload_releases").select("id,submitted_at,published_album_id")
      .eq("id", releaseId).eq("user_id", user.id).maybeSingle();
    if (releaseError) throw releaseError;
    if (!release || release.submitted_at || release.published_album_id) {
      return NextResponse.json({ ok: false, error: "This release can no longer be edited." }, { status: 403 });
    }
    const ext = file.type === "image/jpeg" ? "jpg" : file.type === "image/png" ? "png" : "webp";
    const key = `artist-covers/${user.id}/${releaseId}/${crypto.randomUUID()}.${ext}`;
    await putB2Object(key, new Uint8Array(await file.arrayBuffer()), file.type);
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("artist_upload_releases")
      .update({ art_storage_path: key, art_url: `/artist-release-art/${releaseId}` })
      .eq("id", releaseId).eq("user_id", user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[artist-discography:art]", error);
    return NextResponse.json({ ok: false, error: "Could not save the cover." }, { status: 500 });
  }
}
