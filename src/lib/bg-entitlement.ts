import type { SupabaseClient } from "@supabase/supabase-js";
import { JUKEBOX_SCHEMA, createSjServiceClient } from "@/lib/sj-admin-auth";
import { SJ_BG_STORAGE_BYTES, SJ_BG_YEARS } from "@/lib/stripe";

export type BgEntitlement = {
  user_id: string;
  email: string | null;
  unlocked_at: string;
  unlock_until: string;
  storage_bytes_limit: number;
  storage_bytes_used: number;
  source: string;
};

export function unlockUntilFrom(start = new Date()): Date {
  const d = new Date(start);
  d.setFullYear(d.getFullYear() + SJ_BG_YEARS);
  return d;
}

export function isEntitlementActive(row: Pick<BgEntitlement, "unlock_until"> | null | undefined): boolean {
  if (!row?.unlock_until) return false;
  return new Date(row.unlock_until).getTime() > Date.now();
}

export async function recalcStorageUsed(
  sb: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data: rows, error: rowsError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_audio")
    .select("file_bytes")
    .eq("uploaded_by", userId);
  if (rowsError) throw rowsError;

  // Every upload writes its byte size to track_audio in the same flow that
  // creates the object. Keep quota reads inside the exposed jukebox schema;
  // Supabase intentionally does not expose its private storage schema through
  // the Data API. Deleting an upload removes this metadata row as well.
  return (rows || []).reduce((total, row) => {
    const bytes = Number((row as { file_bytes?: number | null }).file_bytes || 0);
    return Number.isFinite(bytes) && bytes > 0 ? total + bytes : total;
  }, 0);
}

export async function getEntitlement(userId: string): Promise<BgEntitlement | null> {
  const sb = createSjServiceClient();
  const { data } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("bg_entitlements")
    .select(
      "user_id, email, unlocked_at, unlock_until, storage_bytes_limit, storage_bytes_used, source",
    )
    .eq("user_id", userId)
    .maybeSingle();
  return (data as BgEntitlement | null) || null;
}

export async function grantEntitlement(opts: {
  userId: string;
  email?: string | null;
  source: string;
  stripeCustomerId?: string | null;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  from?: Date;
}): Promise<BgEntitlement> {
  const sb = createSjServiceClient();
  const unlockedAt = opts.from || new Date();
  const until = unlockUntilFrom(unlockedAt);
  const used = await recalcStorageUsed(sb, opts.userId);

  const existing = await getEntitlement(opts.userId);
  if (existing && isEntitlementActive(existing) && existing.source === "grandfather" && opts.source === "stripe") {
    // Keep grandfather window if longer; still stamp Stripe ids
  }

  const unlockUntil =
    existing && isEntitlementActive(existing) && new Date(existing.unlock_until) > until
      ? existing.unlock_until
      : until.toISOString();

  const row = {
    user_id: opts.userId,
    email: opts.email ?? existing?.email ?? null,
    unlocked_at: existing?.unlocked_at || unlockedAt.toISOString(),
    unlock_until: unlockUntil,
    storage_bytes_limit: existing?.storage_bytes_limit || SJ_BG_STORAGE_BYTES,
    storage_bytes_used: used,
    stripe_customer_id: opts.stripeCustomerId ?? null,
    stripe_checkout_session_id: opts.stripeCheckoutSessionId ?? null,
    stripe_payment_intent_id: opts.stripePaymentIntentId ?? null,
    source: opts.source,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("bg_entitlements")
    .upsert(row, { onConflict: "user_id" })
    .select(
      "user_id, email, unlocked_at, unlock_until, storage_bytes_limit, storage_bytes_used, source",
    )
    .single();
  if (error) throw error;
  return data as BgEntitlement;
}

export async function syncEntitlementUsage(
  userId: string,
  storageBytesLimit?: number,
): Promise<BgEntitlement | null> {
  const sb = createSjServiceClient();
  const used = await recalcStorageUsed(sb, userId);
  const updates: Record<string, number | string> = {
    storage_bytes_used: used,
    updated_at: new Date().toISOString(),
  };
  if (Number.isFinite(storageBytesLimit) && Number(storageBytesLimit) >= 0) {
    updates.storage_bytes_limit = Number(storageBytesLimit);
  }
  const { data, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("bg_entitlements")
    .update(updates)
    .eq("user_id", userId)
    .select(
      "user_id, email, unlocked_at, unlock_until, storage_bytes_limit, storage_bytes_used, source",
    )
    .maybeSingle();
  if (error) throw error;
  return (data as BgEntitlement | null) || null;
}

export async function logProductEvent(opts: {
  userId?: string | null;
  email?: string | null;
  event: string;
  meta?: Record<string, unknown>;
}) {
  const sb = createSjServiceClient();
  await sb.schema(JUKEBOX_SCHEMA).from("product_events").insert({
    user_id: opts.userId || null,
    email: opts.email || null,
    event: opts.event,
    meta: opts.meta || {},
  });
}
