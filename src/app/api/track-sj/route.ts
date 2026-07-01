// Johnny Outlaw, LLC — Suffering Jukebox — page view tracking
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
async function getGeo(ip: string) {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("::1")) return { city: null, country: null };
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { city: null, country: null };
    const d = await r.json() as { city?: string; country_name?: string };
    return { city: d.city ?? null, country: d.country_name ?? null };
  } catch { return { city: null, country: null }; }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.event === "end") {
      const { view_id, duration_ms, user_email = null } = body;
      if (!view_id || typeof duration_ms !== "number") {
        return NextResponse.json({ ok: false }, { status: 400 });
      }
      const patch: Record<string, unknown> = { duration_ms: Math.max(0, Math.round(duration_ms)) };
      if (user_email) patch.user_email = user_email;
      const sb = createSjClient();
      const { error } = await sb.from("page_views").update(patch).eq("id", view_id);
      if (error) console.error("[track-sj:end]", error.message);
      return NextResponse.json({ ok: !error });
    }

    const { page_path = "/", referrer = "", session_id = "unknown", user_email = null } = body;
    const ua = req.headers.get("user-agent") ?? "";
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? req.headers.get("x-real-ip") ?? "unknown";
    const geo = await getGeo(ip);
    const sb = createSjClient();
    const { data, error: insertErr } = await sb.from("page_views").insert({
      session_id, page_path, referrer: referrer || null, referrer_host: getReferrerHost(referrer),
      device_type: getDeviceType(ua), browser: getBrowser(ua), os: getOS(ua),
      ip_address: ip !== "unknown" ? ip : null, city: geo.city, country: geo.country,
      user_email: user_email || null,
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
    const { view_id, duration_ms, user_email = null } = await req.json();
    if (!view_id || typeof duration_ms !== "number") {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const patch: Record<string, unknown> = { duration_ms: Math.max(0, Math.round(duration_ms)) };
    if (user_email) patch.user_email = user_email;
    const sb = createSjClient();
    const { error } = await sb.from("page_views").update(patch).eq("id", view_id);
    if (error) console.error("[track-sj:patch]", error.message);
    return NextResponse.json({ ok: !error });
  } catch (err) {
    console.error("[track-sj:patch]", err);
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
