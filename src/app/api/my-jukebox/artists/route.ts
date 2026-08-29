import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

// The Explore Artists "My Artists" scope is an ownership filter.  Keep that
// decision on the server, where the authenticated email is authoritative;
// display names are neither stable nor unique.
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const sb = createSjServiceClient();
  const { data, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id")
    .ilike("added_by", user.email.trim());

  if (error) {
    console.error("[my-jukebox:artists]", error);
    return NextResponse.json({ ok: false, error: "Could not load your artists." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, artistIds: (data ?? []).map((artist) => artist.id) });
}
