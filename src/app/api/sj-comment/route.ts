// Johnny Outlaw, LLC — Suffering Jukebox — listener comments
//
// Writes go through here rather than straight to PostgREST for two reasons:
// the visitor's IP address is only knowable server side, and the author's
// email has to come from a verified token instead of the request body.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SJ_SUPABASE_ANON_KEY } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

const SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";

const TARGET_TYPES = new Set(["artist", "album", "track", "lyric"]);
const MAX_BODY = 4000;
const MAX_QUOTE = 1000;

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

// Identity comes from the access token, never from the body — otherwise anyone
// could post a comment under someone else's name.
async function verifiedUser(
  req: NextRequest
): Promise<{ id: string; email: string | null; name: string | null } | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === SJ_SUPABASE_ANON_KEY) return null;
  try {
    const authClient = createClient(SUPABASE_URL, SJ_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) return null;
    const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta.full_name === "string" ? meta.full_name
      : typeof meta.name === "string" ? meta.name
      : null;
    return { id: data.user.id, email: data.user.email ?? null, name };
  } catch {
    return null;
  }
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
}

// Best-effort per-instance throttle, same shape as the page-view tracker.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > RATE_MAX;
}

const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const ms = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.min(Math.round(v), 24 * 60 * 60 * 1000)
    : null;

const offset = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return NextResponse.json({ ok: false, error: "Too many comments — slow down a moment." }, { status: 429 });
    }

    const b = await req.json();

    const targetType = typeof b.target_type === "string" ? b.target_type : "";
    if (!TARGET_TYPES.has(targetType)) {
      return NextResponse.json({ ok: false, error: "Unknown comment target." }, { status: 400 });
    }

    const body = text(b.body, MAX_BODY);
    if (!body) {
      return NextResponse.json({ ok: false, error: "Comment is empty." }, { status: 400 });
    }

    const trackId = uuid(b.track_id);
    const albumId = uuid(b.album_id);
    const artistId = uuid(b.artist_id);
    // Every target type needs the id it is keyed on, or the comment would be
    // written somewhere nothing can ever read it back.
    const anchored =
      (targetType === "artist" && artistId) ||
      (targetType === "album" && albumId) ||
      ((targetType === "track" || targetType === "lyric") && trackId);
    if (!anchored) {
      return NextResponse.json({ ok: false, error: "Comment target is missing." }, { status: 400 });
    }

    const user = await verifiedUser(req);
    // A signed-out listener may still sign their comment with a display name.
    // That name is unverified, so it is stored without an email beside it.
    const named = text(b.user_name, 200);
    const anon = b.is_anonymous === true || (!user && !named);

    const row = {
      target_type: targetType,
      artist_id: artistId,
      album_id: albumId,
      track_id: trackId,
      artist_name: text(b.artist_name, 300),
      album_name: text(b.album_name, 300),
      track_name: text(b.track_name, 300),
      body,
      is_public: b.is_public !== false,
      user_id: anon || !user ? null : user.id,
      user_email: anon || !user ? null : user.email,
      user_name: anon ? null : (user ? (user.name ?? named) : named),
      is_anonymous: anon,
      device_id: text(b.device_id, 100),
      ip_address: ip !== "unknown" ? ip : null,
      playing_track_id: uuid(b.playing_track_id),
      playing_video_id: text(b.playing_video_id, 40),
      playing_track_name: text(b.playing_track_name, 300),
      playing_position_ms: ms(b.playing_position_ms),
      ref_position_ms: ms(b.ref_position_ms),
      lyric_quote: targetType === "lyric" ? text(b.lyric_quote, MAX_QUOTE) : null,
      lyric_start: targetType === "lyric" ? offset(b.lyric_start) : null,
      lyric_end: targetType === "lyric" ? offset(b.lyric_end) : null,
    };

    const sb = createSjClient();
    const { error } = await sb.from("comments").insert(row);
    if (error) {
      console.error("[sj-comment:insert]", error.message);
      return NextResponse.json({ ok: false, error: "Could not save the comment." }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[sj-comment]", err);
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
}
