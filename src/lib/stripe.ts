import Stripe from "stripe";

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!stripe) {
    stripe = new Stripe(key, {
      apiVersion: "2026-07-29.dahlia",
    });
  }
  return stripe;
}

export const SJ_BG_PRICE_ID =
  process.env.STRIPE_BG_PRICE_ID?.trim() || "price_1U2jT3BgSEjfnmpGBo9kj3sy";

export const SJ_BG_STORAGE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
export const SJ_BG_YEARS = 10;
