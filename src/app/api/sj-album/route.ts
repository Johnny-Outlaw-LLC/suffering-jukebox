// Create an empty album on an artist you manage.
//
// The import wizard only knows albums a catalogue has verified, which leaves no
// way to add the ones it does not carry — a B-sides collection, a bootleg, a
// self-released tape. This is that way: name the album, then fill it track by
// track with the YouTube links you already have.
import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { canManageArtist } from "@/lib/artist-manage";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const bad = (error: string, status = 400) =>
  NextResponse.json({ ok: false, error }, { status });

/** Loose enough that "Pinkerton B-Sides" and "Pinkerton B Sides" are one album. */
const fold = (value: string) =>
  value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) return bad("Sign in required.", 401);

  const body = await req.json().catch(() => ({}));
  const artistId = typeof body.artistId === "string" ? body.artistId.trim() : "";
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const year = String(body.year ?? "").trim();
  if (!UUID.test(artistId)) return bad("Choose an artist.");
  if (!name) return bad("Give the album a name.");
  if (year && !/^\d{4}$/.test(year)) return bad("Year must be four digits.");

  const sb = createSjServiceClient();
  if (!(await canManageArtist(sb, user.email, artistId))) {
    return bad("You can only add albums to artists you added.", 403);
  }

  try {
    const { data: artist, error: artistError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id, name, visibility")
      .eq("id", artistId)
      .maybeSingle();
    if (artistError) throw artistError;
    if (!artist) return bad("Artist not found.", 404);

    // Adding the same name twice should land you on the album you meant rather
    // than build a second one beside it.
    const { data: siblings, error: siblingError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .select("id, name")
      .eq("artist_id", artistId);
    if (siblingError) throw siblingError;
    const match = (siblings ?? []).find((a) => fold(a.name || "") === fold(name));
    if (match) return NextResponse.json({ ok: true, albumId: match.id, existing: true });

    const { data: album, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .insert({
        artist_id: artistId,
        name,
        release_date: year ? `${year}-01-01` : null,
        added_by: user.email.toLowerCase(),
        added_by_name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? null,
        // A private artist's albums stay private; everything else follows the
        // column default.
        ...(artist.visibility === "private" ? { visibility: "private" } : {}),
      })
      .select("id")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, albumId: album.id, existing: false });
  } catch (error) {
    console.error("[sj-album:post]", error);
    return bad("Could not create the album.", 500);
  }
}
