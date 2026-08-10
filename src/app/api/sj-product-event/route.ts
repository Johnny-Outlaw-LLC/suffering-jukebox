import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { logProductEvent } from "@/lib/bg-entitlement";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "bg_unlock_cta",
  "bg_unlock_checkout",
  "bg_unlock_paid",
  "bg_unlock_cancel",
  "bg_upload_blocked_locked",
  "bg_upload_blocked_quota",
  "bg_upload_rate_limited",
  "bg_quota_90",
  "bg_bgplay_blocked_locked",
  "bg_home_explore_click",
]);

export async function POST(req: NextRequest) {
  let body: { event?: string; meta?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad JSON." }, { status: 400 });
  }

  const event = (body.event || "").trim();
  if (!ALLOWED.has(event)) {
    return NextResponse.json({ ok: false, error: "Unknown event." }, { status: 400 });
  }

  const user = await getAuthUser(req);
  try {
    await logProductEvent({
      userId: user?.id || null,
      email: user?.email || null,
      event,
      meta: body.meta && typeof body.meta === "object" ? body.meta : {},
    });
  } catch (e) {
    console.error("[sj-product-event]", e);
    return NextResponse.json({ ok: false, error: "Log failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
