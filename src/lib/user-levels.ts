import { createSjServiceClient, JUKEBOX_SCHEMA, SJ_PROTECTED_ADMIN_EMAIL } from "@/lib/sj-admin-auth";

export const USER_LEVELS = ["free", "standard", "premium", "admin"] as const;
export type UserLevel = (typeof USER_LEVELS)[number];

export const USER_STORAGE_LIMITS: Record<UserLevel, number> = {
  free: 0,
  standard: 500 * 1024 * 1024,
  premium: 2 * 1024 * 1024 * 1024,
  admin: 10 * 1024 * 1024 * 1024,
};

export function normalizeUserLevel(value: unknown): UserLevel | null {
  const level = String(value || "").trim().toLowerCase();
  return USER_LEVELS.includes(level as UserLevel) ? level as UserLevel : null;
}

export async function getUserLevel(email: string | null | undefined): Promise<UserLevel> {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return "free";
  if (normalizedEmail === SJ_PROTECTED_ADMIN_EMAIL) return "admin";

  const sb = createSjServiceClient();
  const { data, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("app_users")
    .select("is_admin,user_level")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) {
    console.error("[sj-user-level]", error.message);
    return "free";
  }
  if (data?.is_admin) return "admin";
  return normalizeUserLevel(data?.user_level) || "free";
}
