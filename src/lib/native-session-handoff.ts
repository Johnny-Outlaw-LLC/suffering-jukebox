import type { Session } from "@supabase/supabase-js";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";

type NativeSessionPayload = {
  accessToken?: string;
  refreshToken?: string;
  fromNativeApp?: boolean;
};

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}

/**
 * Receives a session from the bundled Capacitor player. The payload lives in
 * the fragment, which is not sent to the web server, and is removed from the
 * address bar before the destination renders private account data.
 */
export async function consumeNativeSessionHandoff(): Promise<{
  session: Session | null;
  fromNativeApp: boolean;
} | null> {
  const prefix = "#sj-app-session=";
  if (!window.location.hash.startsWith(prefix)) return null;

  const encoded = window.location.hash.slice(prefix.length);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);

  try {
    const payload = JSON.parse(decodeBase64Url(encoded)) as NativeSessionPayload;
    if (!payload.accessToken || !payload.refreshToken) {
      return { session: null, fromNativeApp: payload.fromNativeApp === true };
    }
    const { data, error } = await sjBrowserAuth.auth.setSession({
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
    });
    if (error) throw error;
    return { session: data.session, fromNativeApp: payload.fromNativeApp === true };
  } catch {
    return null;
  }
}
