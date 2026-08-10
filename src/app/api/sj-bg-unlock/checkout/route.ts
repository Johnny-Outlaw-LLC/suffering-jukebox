import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { getEntitlement, isEntitlementActive, logProductEvent } from "@/lib/bg-entitlement";
import { getStripe, SJ_BG_PRICE_ID } from "@/lib/stripe";

export const dynamic = "force-dynamic";

function siteOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  if (host.includes("sufferingjukebox.stream")) {
    return "https://www.sufferingjukebox.stream";
  }
  return `${proto}://${host}`;
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const existing = await getEntitlement(user.id);
  if (isEntitlementActive(existing)) {
    return NextResponse.json({
      ok: true,
      alreadyUnlocked: true,
      until: existing!.unlock_until,
    });
  }

  const origin = siteOrigin(req);
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: SJ_BG_PRICE_ID, quantity: 1 }],
    success_url: `${origin}/?bg_unlock=success`,
    cancel_url: `${origin}/?bg_unlock=cancel`,
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: {
      user_id: user.id,
      email: user.email,
      app: "suffering-jukebox",
      sku: "bg_play_forever",
    },
    // Tag for Dashboard comparison (API 2026-03-25+)
    // integration_identifier omitted if older Stripe accounts reject it
  } as Parameters<typeof stripe.checkout.sessions.create>[0]);

  await logProductEvent({
    userId: user.id,
    email: user.email,
    event: "bg_unlock_checkout",
    meta: { session_id: session.id },
  });

  return NextResponse.json({ ok: true, url: session.url, sessionId: session.id });
}
