import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

// The Explore Artists "My Artists" scope is an ownership filter. Legacy
// imports were credited by display name while newer ones carry added_by email,
// so resolve both server-side and return their union.
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
  const [{ data: emailRows, error: emailError }, { data: nameRows, error: nameError }] = await Promise.all([byEmail, byName]);

  if (emailError || nameError) {
    console.error("[my-jukebox:artists]", emailError || nameError);
    return NextResponse.json({ ok: false, error: "Could not load your artists." }, { status: 500 });
  }

  const artistIds = [...new Set([...(emailRows ?? []), ...(nameRows ?? [])].map((artist) => artist.id))];
  return NextResponse.json({ ok: true, artistIds });
}
