import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { ownerMyJukebox } from "@/lib/my-jukebox";

export const dynamic = "force-dynamic";

const T = (sb: ReturnType<typeof createSjServiceClient>, table: string) =>
  sb.schema(JUKEBOX_SCHEMA).from(table);

// Explore Artists "My Artists" is whoever you imported plus any artist you
// claimed through Add to My Library (my_jukebox_items).
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const sb = createSjServiceClient();
  const displayNames = [
    user.user_metadata?.full_name,
    user.user_metadata?.name,
  ].filter((name): name is string => typeof name === "string" && !!name.trim());
  const byEmail = sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id")
    .ilike("added_by", user.email.trim());
  const byName = displayNames.length
    ? sb.schema(JUKEBOX_SCHEMA).from("artists").select("id").in("added_by_name", displayNames)
    : Promise.resolve({ data: [], error: null });

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
    { data: libRows, error: libError },
  ] = await Promise.all([byEmail, byName, libraryArtists]);

  if (emailError || nameError || libError) {
    console.error("[my-jukebox:artists]", emailError || nameError || libError);
    return NextResponse.json({ ok: false, error: "Could not load your artists." }, { status: 500 });
  }

  const artistIds = new Set<string>();
  for (const row of emailRows ?? []) if (row.id) artistIds.add(row.id);
  for (const row of nameRows ?? []) if (row.id) artistIds.add(row.id);
  for (const row of libRows ?? []) {
    const track = row.tracks as { albums?: { artist_id?: string } | null } | null;
    const artistId = track?.albums?.artist_id;
    if (artistId) artistIds.add(artistId);
  }

  return NextResponse.json({ ok: true, artistIds: [...artistIds] });
}
