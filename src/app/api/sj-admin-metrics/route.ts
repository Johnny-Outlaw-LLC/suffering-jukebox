// Johnny Outlaw, LLC — Suffering Jukebox — admin in-app metrics
import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, verifySjAdmin, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

const DETAIL_METRICS = new Set([
  "page_loads",
  "avg_time",
  "logged_in",
  "anonymous",
  "songs_rated",
  "songs_played",
]);

type Metrics = {
  pageLoads: number;
  avgPageOpenMs: number;
  loggedInUsers: number;
  anonymousUsers: number;
  songsRated: number;
  songsPlayed: number;
};

export async function GET(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;

  const detail = req.nextUrl.searchParams.get("detail");
  const dashboard = req.nextUrl.searchParams.get("dashboard");
  const sb = createSjServiceClient();

  try {
    if (dashboard) {
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("admin_dashboard");
      if (error) throw error;
      return NextResponse.json({ ok: true, dashboard: data });
    }

    if (detail) {
      if (!DETAIL_METRICS.has(detail)) {
        return NextResponse.json({ ok: false, error: "Unknown metric." }, { status: 400 });
      }
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("admin_metric_detail", { p_metric: detail });
      if (error) throw error;
      return NextResponse.json({ ok: true, ...(data as object) });
    }

    const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("admin_metrics");
    if (error) throw error;
    const metrics = data as Metrics;
    return NextResponse.json({ ok: true, metrics });
  } catch (err) {
    console.error("[sj-admin-metrics]", err);
    return NextResponse.json({ ok: false, error: "Could not load metrics." }, { status: 500 });
  }
}
