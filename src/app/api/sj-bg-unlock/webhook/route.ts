import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { grantEntitlement, logProductEvent } from "@/lib/bg-entitlement";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Webhook not configured." }, { status: 500 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ ok: false, error: "Missing signature." }, { status: 400 });
  }

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    console.error("[sj-bg-webhook] signature", err);
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.app && session.metadata.app !== "suffering-jukebox") {
      return NextResponse.json({ ok: true, skipped: true });
    }
    if (session.metadata?.sku && session.metadata.sku !== "bg_play_forever") {
      return NextResponse.json({ ok: true, skipped: true });
    }

    const userId =
      session.client_reference_id ||
      session.metadata?.user_id ||
      null;
    if (!userId) {
      console.error("[sj-bg-webhook] missing user id", session.id);
      return NextResponse.json({ ok: false, error: "Missing user." }, { status: 400 });
    }

    const email = session.customer_details?.email || session.customer_email || session.metadata?.email || null;
    const pi =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null;
    const customer =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id || null;

    try {
      await grantEntitlement({
        userId,
        email,
        source: "stripe",
        stripeCustomerId: customer,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: pi,
      });
      await logProductEvent({
        userId,
        email,
        event: "bg_unlock_paid",
        meta: { session_id: session.id, amount_total: session.amount_total },
      });
    } catch (e) {
      console.error("[sj-bg-webhook] grant", e);
      return NextResponse.json({ ok: false, error: "Grant failed." }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
