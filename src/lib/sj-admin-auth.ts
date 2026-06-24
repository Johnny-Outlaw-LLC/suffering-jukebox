import { NextRequest, NextResponse } from "next/server";
import { createClient, type User } from "@supabase/supabase-js";

export const JUKEBOX_SCHEMA = "jukebox";
export const SJ_PROTECTED_ADMIN_EMAIL = "johnnyoutlawllc@gmail.com";

export const SJ_SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";
export const SJ_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";
function requireServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return key;
}

export function createSjServiceClient() {
  return createClient(SJ_SUPABASE_URL, requireServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createSjAuthClient() {
  return createClient(SJ_SUPABASE_URL, SJ_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function getAuthUser(req: NextRequest): Promise<User | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const authClient = createSjAuthClient();
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function isSjAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const sb = createSjServiceClient();
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("is_app_admin", {
    p_email: email,
  });
  if (error) {
    console.error("[sj-admin] is_app_admin", error.message);
    return email.toLowerCase() === "johnnyoutlawllc@gmail.com";
  }
  return !!data;
}

export async function verifySjAdmin(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return { error: NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 }) };
  }
  const admin = await isSjAdmin(user.email);
  if (!admin) {
    return { error: NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 }) };
  }
  return { ok: true as const, user };
}

export async function upsertSjAppUser(email: string, name?: string | null) {
  const sb = createSjServiceClient();
  await sb.schema(JUKEBOX_SCHEMA).rpc("upsert_app_user", {
    p_email: email,
    p_name: name ?? null,
  });
}

export async function getSjLastUpdated(): Promise<string | null> {
  const sb = createSjServiceClient();
  const { data, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("app_meta")
    .select("value, updated_at")
    .eq("key", "last_updated")
    .maybeSingle();
  if (error || !data) return null;
  return data.value || data.updated_at || null;
}

export function parseYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      return id && id.length === 11 ? id : null;
    }
    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && v.length === 11) return v;
      const embed = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embed) return embed[1];
    }
  } catch {
    return null;
  }
  return null;
}

export async function fetchYouTubeVideoStats(videoId: string) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YouTube API key not configured.");
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "statistics,snippet");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube API error (${res.status})`);
  const json = (await res.json()) as {
    items?: Array<{
      statistics?: { viewCount?: string; likeCount?: string };
      snippet?: { thumbnails?: { medium?: { url?: string }; default?: { url?: string } } };
    }>;
  };
  const item = json.items?.[0];
  if (!item) throw new Error("Video not found on YouTube.");
  const thumbs = item.snippet?.thumbnails;
  return {
    views: Number(item.statistics?.viewCount ?? 0),
    likes: Number(item.statistics?.likeCount ?? 0),
    thumbnail: thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
  };
}
