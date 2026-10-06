// Johnny Outlaw, LLC — Listening Party / Suffering Jukebox — artist stats
//
// GET /api/artist-stats                 -> the artists this account can see stats for
// GET /api/artist-stats?artist=<slug>   -> one artist's stats (days=7|30|90|365, tz=IANA zone)
//
// jukebox.artist_stats() is service-role only and returns counts, never people.
// This route is the gate: the signed-in user comes from the verified token,
// and canViewArtistStats decides which artists they may open.
import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { canViewArtistStats, listStatsArtists } from "@/lib/artist-manage";
import { groupReferrers, lyricAt } from "@/lib/artist-stats";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = [7, 30, 90, 365];

type Moment = {
  track_id: string;
  name: string;
  duration_ms: number | null;
  start_ms: number;
  n: number;
  total: number;
  buckets: { s: number; n: number }[];
  lyrics_synced?: string | null;
  lyric?: string | null;
};

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const sb = createSjServiceClient();

  try {
    const artists = await listStatsArtists(sb, user);
    const slug = (req.nextUrl.searchParams.get("artist") || "").trim().toLowerCase();
    if (!slug) return NextResponse.json({ ok: true, artists });

    const { data: artist } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id, name, slug")
      .eq("slug", slug)
      .maybeSingle();
    if (!artist) {
      return NextResponse.json({ ok: false, error: "No artist at that address.", artists }, { status: 404 });
    }
    if (!(await canViewArtistStats(sb, user, artist.id))) {
      return NextResponse.json(
        { ok: false, error: "Stats are only for the artist and the people who manage their music.", artists },
        { status: 403 },
      );
    }

    const daysRaw = parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10);
    const days = DAY_OPTIONS.includes(daysRaw) ? daysRaw : 30;
    const tzRaw = req.nextUrl.searchParams.get("tz") || "UTC";
    const tz = /^[A-Za-z0-9_+\-/]{1,64}$/.test(tzRaw) ? tzRaw : "UTC";

    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .rpc("artist_stats", { p_artist_id: artist.id, p_days: days, p_tz: tz });
    if (error) throw error;
    if (!data) return NextResponse.json({ ok: false, error: "No stats for that artist." }, { status: 404 });

    // The page needs the one line fans hearted, not every song's full lyrics.
    const moments = ((data.moments || []) as Moment[]).map(({ lyrics_synced, ...m }) => ({
      ...m,
      lyric: lyricAt(lyrics_synced, m.start_ms),
    }));
    const stats = { ...data, moments, referrers: groupReferrers(data.referrers || []) };
    return NextResponse.json({ ok: true, artists, stats });
  } catch (err) {
    console.error("[artist-stats]", err);
    return NextResponse.json({ ok: false, error: "Could not load stats." }, { status: 500 });
  }
}
