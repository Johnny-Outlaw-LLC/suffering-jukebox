import { NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  getSjLastUpdated,
  isSjAdmin,
  upsertSjAppUser,
} from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  const lastUpdated = await getSjLastUpdated();
  if (!user?.email) {
    return NextResponse.json({ ok: true, isAdmin: false, lastUpdated });
  }
  const admin = await isSjAdmin(user.email);
  return NextResponse.json({
    ok: true,
    isAdmin: admin,
    lastUpdated,
    email: user.email,
    name: user.user_metadata?.full_name ?? user.email,
  });
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  await upsertSjAppUser(
    user.email,
    (user.user_metadata?.full_name as string | undefined) ?? null,
  );
  const admin = await isSjAdmin(user.email);
  const lastUpdated = await getSjLastUpdated();
  return NextResponse.json({ ok: true, isAdmin: admin, lastUpdated });
}
