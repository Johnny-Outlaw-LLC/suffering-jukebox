import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { ownerMyJukebox } from "@/lib/my-jukebox";

export const dynamic = "force-dynamic";

const T = (sb: ReturnType<typeof createSjServiceClient>, table: string) =>
  sb.schema(JUKEBOX_SCHEMA).from(table);

// Explore Artists "My Artists" is whoever you imported (artists.added_by,
// albums.added_by, or content_access) plus any artist you claimed through
// Add to My Library (my_jukebox_items).
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const sb = createSjServiceClient();
  const email = user.email.trim();
  const emailLower = email.toLowerCase();
  const displayNames = [
    user.user_metadata?.full_name,
    user.user_metadata?.name,
  ].filter((name): name is string => typeof name === "string" && !!name.trim());
  const byEmail = sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id")
    .ilike("added_by", email);
  const byName = displayNames.length
    ? sb.schema(JUKEBOX_SCHEMA).from("artists").select("id").in("added_by_name", displayNames)
    : Promise.resolve({ data: [], error: null });
  const byAccess = T(sb, "content_access")
    .select("artist_id")
    .ilike("user_email", email);
  const byAlbums = T(sb, "albums")
    .select("artist_id")
    .ilike("added_by", email)
    .limit(5000);

  const ownerCtx = await ownerMyJukebox(req);
  const libraryArtists = ownerCtx
    ? T(sb, "my_jukebox_items")
        .select("tracks!inner(albums!inner(artist_id))")
        .eq("jukebox_id", ownerCtx.jukebox.id)
        .not("catalog_track_id", "is", null)
        .limit(5000)
    : Promise.resolve({ data: [], error: null });

  const [
    { data: emailRows, error: emailError },
    { data: nameRows, error: nameError },
    { data: accessRows, error: accessError },
    { data: albumRows, error: albumError },
    { data: libRows, error: libError },
  ] = await Promise.all([byEmail, byName, byAccess, byAlbums, libraryArtists]);

  if (emailError || nameError || accessError || albumError || libError) {
    console.error("[my-jukebox:artists]", emailError || nameError || accessError || albumError || libError);
    return NextResponse.json({ ok: false, error: "Could not load your artists." }, { status: 500 });
  }

  const artistIds = new Set<string>();
  for (const row of emailRows ?? []) if (row.id) artistIds.add(row.id);
  for (const row of nameRows ?? []) if (row.id) artistIds.add(row.id);
  for (const row of accessRows ?? []) {
    if (row.artist_id) artistIds.add(row.artist_id);
  }
  for (const row of albumRows ?? []) {
    if (row.artist_id) artistIds.add(row.artist_id);
  }
  for (const row of libRows ?? []) {
    const track = row.tracks as { albums?: { artist_id?: string } | null } | null;
    const artistId = track?.albums?.artist_id;
    if (artistId) artistIds.add(artistId);
  }

  // Drop private artists the caller does not own — content_access on a
  // private row is a ledger entry, not a viewing grant (see 20260831).
  if (artistIds.size) {
    const ids = [...artistIds];
    const { data: visibilityRows, error: visError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id,visibility,added_by")
      .in("id", ids);
    if (visError) {
      console.error("[my-jukebox:artists]", visError);
      return NextResponse.json({ ok: false, error: "Could not load your artists." }, { status: 500 });
    }
    for (const row of visibilityRows ?? []) {
      const priv = (row.visibility || "public") === "private";
      const owned = (row.added_by || "").toLowerCase() === emailLower;
      if (priv && !owned) artistIds.delete(row.id);
    }
  }

  return NextResponse.json({ ok: true, artistIds: [...artistIds] });
}
