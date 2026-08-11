import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, createSjServiceClient } from "@/lib/sj-admin-auth";
import {
  getEntitlement,
  recalcStorageUsed,
  syncEntitlementUsage,
} from "@/lib/bg-entitlement";
import { SJ_BG_STORAGE_BYTES } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  let used = 0;
  let unlockedAt: string | null = null;
  let source: string | null = "free";

  const existing = await getEntitlement(user.id);
  if (existing) {
    try {
      const synced = await syncEntitlementUsage(user.id);
      used = synced?.storage_bytes_used ?? existing.storage_bytes_used ?? 0;
      unlockedAt = synced?.unlocked_at || existing.unlocked_at || null;
      source = synced?.source || existing.source || "free";
    } catch (e) {
      console.error("[sj-bg-status] recalc", e);
      used = existing.storage_bytes_used || 0;
      unlockedAt = existing.unlocked_at || null;
      source = existing.source || "free";
    }
  } else {
    try {
      used = await recalcStorageUsed(createSjServiceClient(), user.id);
    } catch (e) {
      console.error("[sj-bg-status] usage", e);
    }
  }

  // Uploads and background play are free for signed-in users (500 MB cap).
  return NextResponse.json({
    ok: true,
    unlocked: true,
    until: null,
    unlockedAt,
    used,
    limit: SJ_BG_STORAGE_BYTES,
    source,
  });
}
