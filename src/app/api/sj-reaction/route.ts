// Johnny Outlaw, LLC — Suffering Jukebox — one-tap track reactions
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SJ_SUPABASE_ANON_KEY } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

const SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";
const REACTIONS = ["heart", "sad"] as const;
type Reaction = (typeof REACTIONS)[number];

const REACTION_SET = new Set<string>(REACTIONS);
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 90;
const hits = new Map<string, number[]>();

function requireServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  return key;
}

function createSjClient() {
  return createClient(SUPABASE_URL, requireServiceRoleKey(), {
    db: { schema: "jukebox" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function verifiedUserId(req: NextRequest): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === SJ_SUPABASE_ANON_KEY) return null;
  try {
    const authClient = createClient(SUPABASE_URL, SJ_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await authClient.auth.getUser(token);
    return error ? null : (data.user?.id ?? null);
  } catch {
    return null;
  }
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, values] of hits) {
      if (!values.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > RATE_MAX;
}

const uuid = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;

const deviceId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length >= 8 && clean.length <= 100 ? clean : null;
};

const positionMs = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 86_400_000)
    : null;

async function reactionCounts(trackId: string) {
  const counts = Object.fromEntries(REACTIONS.map((reaction) => [reaction, 0])) as Record<Reaction, number>;
  const { data, error } = await createSjClient()
    .from("track_reaction_totals")
    .select("reaction,reaction_count")
    .eq("track_id", trackId);
  if (error) throw error;
  for (const row of data ?? []) {
    if (REACTION_SET.has(row.reaction)) counts[row.reaction as Reaction] = Number(row.reaction_count) || 0;
  }
  return counts;
}

const TIMELINE_CAP = 2500;

async function reactionTimeline(trackId: string) {
  const timeline = Object.fromEntries(REACTIONS.map((reaction) => [reaction, [] as number[]])) as Record<Reaction, number[]>;
  const { data, error } = await createSjClient()
    .from("track_reactions")
    .select("reaction,position_ms")
    .eq("track_id", trackId)
    .not("position_ms", "is", null)
    .in("reaction", [...REACTIONS])
    .order("position_ms", { ascending: true })
    .limit(TIMELINE_CAP);
  if (error) throw error;
  for (const row of data ?? []) {
    if (!REACTION_SET.has(row.reaction)) continue;
    const ms = Number(row.position_ms);
    if (Number.isFinite(ms) && ms >= 0) timeline[row.reaction as Reaction].push(ms);
  }
  return timeline;
}

export async function GET(req: NextRequest) {
  try {
    const trackId = uuid(req.nextUrl.searchParams.get("track_id"));
    if (!trackId) return NextResponse.json({ ok: false, error: "Invalid track." }, { status: 400 });
    const withTimeline = req.nextUrl.searchParams.get("timeline") === "1";
    const [counts, timeline] = await Promise.all([
      reactionCounts(trackId),
      withTimeline ? reactionTimeline(trackId) : Promise.resolve(null),
    ]);
    return NextResponse.json({
      ok: true,
      counts,
      ...(timeline ? { timeline } : {}),
    });
  } catch (error) {
    console.error("[sj-reaction:get]", error);
    return NextResponse.json({ ok: false, error: "Could not load reactions." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return NextResponse.json({ ok: false, error: "Easy there — give the reactions a second." }, { status: 429 });
    }

    const body = await req.json();
    const trackId = uuid(body.track_id);
    const reaction = typeof body.reaction === "string" && REACTION_SET.has(body.reaction)
      ? body.reaction as Reaction
      : null;
    const device = deviceId(body.device_id);
    if (!trackId || !reaction || !device) {
      return NextResponse.json({ ok: false, error: "Invalid reaction." }, { status: 400 });
    }

    const sb = createSjClient();
    const { data, error } = await sb.from("track_reactions").insert({
      track_id: trackId,
      reaction,
      user_id: await verifiedUserId(req),
      device_id: device,
      position_ms: positionMs(body.position_ms),
    }).select("id").single();
    if (error) {
      console.error("[sj-reaction:insert]", error.message);
      return NextResponse.json({ ok: false, error: "Could not save the reaction." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, reaction_id: data.id, counts: await reactionCounts(trackId) });
  } catch (error) {
    console.error("[sj-reaction:post]", error);
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return NextResponse.json({ ok: false, error: "Easy there — give the reactions a second." }, { status: 429 });
    }

    const body = await req.json();
    const trackId = uuid(body.track_id);
    const reaction = typeof body.reaction === "string" && REACTION_SET.has(body.reaction)
      ? body.reaction as Reaction
      : null;
    const device = deviceId(body.device_id);
    const rawReactionIds: unknown[] = Array.isArray(body.reaction_ids) ? body.reaction_ids : [];
    const reactionIds = rawReactionIds.length
      ? [...new Set(rawReactionIds.map(uuid).filter((id): id is string => Boolean(id)))].slice(0, 100)
      : [];
    if (!trackId || !reaction || !device || !reactionIds.length) {
      return NextResponse.json({ ok: false, error: "Invalid reaction undo." }, { status: 400 });
    }

    // IDs are returned only to the browser that created them. Device + track +
    // reaction matching keeps an undo tightly scoped to this session's presses.
    const { data, error } = await createSjClient()
      .from("track_reactions")
      .delete()
      .eq("track_id", trackId)
      .eq("reaction", reaction)
      .eq("device_id", device)
      .in("id", reactionIds)
      .select("id");
    if (error) {
      console.error("[sj-reaction:delete]", error.message);
      return NextResponse.json({ ok: false, error: "Could not undo the reaction." }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      deleted: (data ?? []).map((row) => row.id),
      counts: await reactionCounts(trackId),
    });
  } catch (error) {
    console.error("[sj-reaction:delete]", error);
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
}
