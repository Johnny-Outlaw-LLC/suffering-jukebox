import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import {
  getEntitlement,
  isEntitlementActive,
  syncEntitlementUsage,
} from "@/lib/bg-entitlement";
import { SJ_BG_STORAGE_BYTES } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  let row = await getEntitlement(user.id);
  if (row) {
    try {
      row = (await syncEntitlementUsage(user.id)) || row;
    } catch (e) {
      console.error("[sj-bg-status] recalc", e);
    }
  }

  const unlocked = isEntitlementActive(row);
  return NextResponse.json({
    ok: true,
    unlocked,
    until: row?.unlock_until || null,
    unlockedAt: row?.unlocked_at || null,
    used: row?.storage_bytes_used || 0,
    limit: row?.storage_bytes_limit || SJ_BG_STORAGE_BYTES,
    source: row?.source || null,
  });
}
