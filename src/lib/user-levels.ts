import { createSjServiceClient, JUKEBOX_SCHEMA, SJ_PROTECTED_ADMIN_EMAIL } from "@/lib/sj-admin-auth";

export const USER_LEVELS = ["free", "standard", "premium", "admin"] as const;
export type UserLevel = (typeof USER_LEVELS)[number];

// One allowance for everyone while the site is being built out: 500 MB.
// The tiers (free 0, premium 2 GB) are deliberately collapsed rather than
// deleted - the level column still exists, so restoring a ladder later is a
// change to these numbers and nothing else. `admin` keeps its ceiling because
// it is staff tooling, not a product tier, and cutting it would put existing
// uploads over quota. /help#how is the published promise: 500 MB, everyone.
const SJ_STORAGE_FOR_EVERYONE = 500 * 1024 * 1024;

export const USER_STORAGE_LIMITS: Record<UserLevel, number> = {
  free: SJ_STORAGE_FOR_EVERYONE,
  standard: SJ_STORAGE_FOR_EVERYONE,
  premium: SJ_STORAGE_FOR_EVERYONE,
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
