// Johnny Outlaw, LLC — Suffering Jukebox — signed-in listener's own play/analytics data
//
// The signed-in email always comes from the verified access token, never from
// a query param — otherwise any signed-in user could read anyone else's
// listening history by passing a different email.
import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const sb = createSjServiceClient();
  const email = user.email.toLowerCase();

  try {
    const exportKind = req.nextUrl.searchParams.get("export");
    if (exportKind === "artists" || exportKind === "all-artists") {
      const { data, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .rpc("my_artist_details", {
          p_user: email,
          p_scope: exportKind === "all-artists" ? "all" : "mine",
        });
      if (error) throw error;
      return NextResponse.json({ ok: true, artists: data ?? [] });
    }

    const daysRaw = parseInt(req.nextUrl.searchParams.get("days") ?? "365", 10);
    const days = [30, 90, 365, 3650].includes(daysRaw) ? daysRaw : 365;
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .rpc("my_dashboard_data", { p_user: email, p_days: days });
    if (error) throw error;
    return NextResponse.json({ ok: true, dashboard: data });
  } catch (err) {
    console.error("[sj-my-stats]", err);
    return NextResponse.json({ ok: false, error: "Could not load your stats." }, { status: 500 });
  }
}
