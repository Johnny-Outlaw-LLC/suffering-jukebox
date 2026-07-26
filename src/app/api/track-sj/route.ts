// Johnny Outlaw, LLC — Suffering Jukebox — page view tracking
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SJ_SUPABASE_ANON_KEY } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

const SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";

function requireServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return key;
}

function createSjClient() {
  return createClient(SUPABASE_URL, requireServiceRoleKey(), {
    db: { schema: "jukebox" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The signed-in visitor's email comes from a verified access token, never from
// the request body — otherwise anyone could attribute traffic to any address.
async function verifiedEmail(req: NextRequest): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === SJ_SUPABASE_ANON_KEY) return null;
  try {
    const authClient = createClient(SUPABASE_URL, SJ_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user?.email) return null;
    return data.user.email;
  } catch {
    return null;
  }
}

function getDeviceType(ua: string) { return /tablet|ipad/i.test(ua) ? "tablet" : /mobile|android|iphone|ipod/i.test(ua) ? "mobile" : "desktop"; }
function getBrowser(ua: string) { return /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera" : /Chrome\//i.test(ua) ? "Chrome" : /Firefox\//i.test(ua) ? "Firefox" : /Safari\//i.test(ua) ? "Safari" : "Other"; }
function getOS(ua: string) { return /Windows/i.test(ua) ? "Windows" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Mac OS X/i.test(ua) ? "macOS" : /Android/i.test(ua) ? "Android" : /Linux/i.test(ua) ? "Linux" : "Other"; }
function getReferrerHost(ref: string) {
  if (!ref) return "(direct)";
  if (ref.startsWith("utm:")) {
    const parts = ref.slice(4).split("/");
    const src = parts[0] || "campaign";
    const med = parts[1];
    if (src === "share" && med) return `Share (${med})`;
    return src;
  }
  if (ref.startsWith("ref:")) return ref.slice(4) || "link";
  try {
    const u = new URL(ref);
    const h = u.hostname.replace(/^www\./, "");
    if (h === "sufferingjukebox.stream" || h === "www.sufferingjukebox.stream") return "(internal)";
    if (h === "mail.google.com" || h === "gmail.com") return "Gmail";
    if (h === "google.com" && u.pathname.startsWith("/url")) return "Gmail";
    if (h.includes("outlook.")) return "Outlook";
    return h;
  } catch { return "(unknown)"; }
}

// Geo comes from the edge network's own request headers. We deliberately do not
// send visitor IP addresses to a third-party lookup service.
function getGeo(req: NextRequest): { city: string | null; country: string | null } {
  const rawCity = req.headers.get("x-vercel-ip-city");
  let city: string | null = null;
  if (rawCity) {
    try { city = decodeURIComponent(rawCity) || null; } catch { city = rawCity; }
  }
  const code = req.headers.get("x-vercel-ip-country");
  let country: string | null = code || null;
  if (code) {
    try {
      country = new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
    } catch { country = code; }
  }
  return { city, country };
}

// Best-effort throttle. Each serverless instance keeps its own counter, so this
// blunts floods rather than enforcing a precise global quota.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
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

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
}

// A duration update may only touch a row belonging to the caller's own session,
// so a guessed view_id is not enough to tamper with someone else's page view.
async function applyDuration(viewId: unknown, durationMs: unknown, sessionId: unknown) {
  if (typeof viewId !== "string" || !viewId || typeof durationMs !== "number") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (typeof sessionId !== "string" || !sessionId) {
    return NextResponse.json({ ok: false, error: "session_id required." }, { status: 400 });
  }
  const sb = createSjClient();
  const { error } = await sb
    .from("page_views")
    .update({ duration_ms: Math.max(0, Math.round(durationMs)) })
    .eq("id", viewId)
    .eq("session_id", sessionId);
  if (error) console.error("[track-sj:duration]", error.message);
  return NextResponse.json({ ok: !error });
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
    }

    const body = await req.json();

    if (body.event === "end") {
      return applyDuration(body.view_id, body.duration_ms, body.session_id);
    }

    const { page_path = "/", referrer = "", session_id = "unknown" } = body;
    const ua = req.headers.get("user-agent") ?? "";
    const geo = getGeo(req);
    const email = await verifiedEmail(req);
    const sb = createSjClient();
    const { data, error: insertErr } = await sb.from("page_views").insert({
      session_id, page_path, referrer: referrer || null, referrer_host: getReferrerHost(referrer),
      device_type: getDeviceType(ua), browser: getBrowser(ua), os: getOS(ua),
      ip_address: ip !== "unknown" ? ip : null, city: geo.city, country: geo.country,
      user_email: email,
    }).select("id").single();
    if (insertErr) console.error("[track-sj:insert]", insertErr.message);
    return NextResponse.json({ ok: !insertErr, id: data?.id ?? null });
  } catch (err) {
    console.error("[track-sj]", err);
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    if (rateLimited(clientIp(req))) {
      return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
    }
    const { view_id, duration_ms, session_id } = await req.json();
    return applyDuration(view_id, duration_ms, session_id);
  } catch (err) {
    console.error("[track-sj:patch]", err);
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
