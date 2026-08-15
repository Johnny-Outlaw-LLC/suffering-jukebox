import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, verifySjAdmin, JUKEBOX_SCHEMA, SJ_PROTECTED_ADMIN_EMAIL } from "@/lib/sj-admin-auth";
import { normalizeUserLevel, type UserLevel } from "@/lib/user-levels";

export const dynamic = "force-dynamic";

type AdminUserRow = {
  email: string;
  user_id: string | null;
  user_name: string | null;
  is_admin: boolean;
  user_level: UserLevel;
  first_seen_at: string;
  last_seen_at: string;
  visit_count: number;
  rating_count: number;
  play_count: number;
  upload_count: number;
  storage_bytes_used: number;
  storage_bytes_limit: number;
  uploaded_artists: Array<{
    name: string;
    upload_count: number;
    storage_bytes: number;
  }>;
};

export async function GET(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;

  const sb = createSjServiceClient();
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("admin_users_list");
  if (error) {
    console.error("[sj-admin-users]", error);
    return NextResponse.json({ ok: false, error: "Could not load users." }, { status: 500 });
  }

  const users = (data as AdminUserRow[] | null) ?? [];
  return NextResponse.json({
    ok: true,
    users,
    total: users.length,
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;

  const body = await req.json();
  const email = String(body.email || "").trim().toLowerCase();
  const requestedLevel = normalizeUserLevel(
    body.user_level ?? (body.is_admin ? "admin" : "free"),
  );
  if (!email) {
    return NextResponse.json({ ok: false, error: "Email required." }, { status: 400 });
  }
  if (!requestedLevel) {
    return NextResponse.json({ ok: false, error: "Invalid user level." }, { status: 400 });
  }
  if (email === SJ_PROTECTED_ADMIN_EMAIL && requestedLevel !== "admin") {
    return NextResponse.json({ ok: false, error: "This owner admin cannot be demoted." }, { status: 403 });
  }

  const sb = createSjServiceClient();
  const { error: upsertErr } = await sb.schema(JUKEBOX_SCHEMA).rpc("set_app_user_level", {
    p_email: email,
    p_level: requestedLevel,
  });
  if (upsertErr) {
    console.error("[sj-admin-users:patch]", upsertErr);
    return NextResponse.json({ ok: false, error: "Could not update user." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    email,
    is_admin: requestedLevel === "admin",
    user_level: requestedLevel,
  });
}
