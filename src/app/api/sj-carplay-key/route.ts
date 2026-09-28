import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { hashCarKey, newCarKey } from "@/lib/carplay-library";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/// Issue a car key to the iPhone app for the signed-in listener. One live key
/// per device: issuing again (a new sign-in, a different account) revokes the
/// device's previous key rather than leaving it working in a drawer.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  let deviceId: string | null = null;
  try {
    const body = await req.json();
    const raw = String(body?.deviceId || "").trim();
    deviceId = /^[A-Za-z0-9_-]{6,80}$/.test(raw) ? raw : null;
  } catch { /* body is optional */ }
  try {
    const sb = createSjServiceClient();
    if (deviceId) {
      await sb.schema(JUKEBOX_SCHEMA).from("carplay_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("device_id", deviceId).is("revoked_at", null);
    }
    const key = newCarKey();
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("carplay_keys")
      .insert({ user_id: user.id, token_hash: key.hash, device_id: deviceId });
    if (error) throw error;
    return noStore({ ok: true, key: key.raw, email: user.email ?? null });
  } catch (error) {
    console.error("[sj-carplay-key] issue", error);
    return noStore({ ok: false, error: "Could not create a CarPlay key." }, 500);
  }
}

/// Revoke the key the phone is holding (sign-out). Authenticated by the key
/// itself, so it works even when the web session has already gone.
export async function DELETE(req: NextRequest) {
  const m = /^Bearer\s+(\S+)$/.exec((req.headers.get("authorization") || "").trim());
  if (!m) return noStore({ ok: true });
  try {
    await createSjServiceClient().schema(JUKEBOX_SCHEMA).from("carplay_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", hashCarKey(m[1])).is("revoked_at", null);
    return noStore({ ok: true });
  } catch (error) {
    console.error("[sj-carplay-key] revoke", error);
    return noStore({ ok: false }, 500);
  }
}
