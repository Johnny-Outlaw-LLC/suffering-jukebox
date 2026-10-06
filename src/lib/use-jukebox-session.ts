"use client";

// The signed-in session for a hosted tool page (/analytics, /artist-stats).
//
// The player opens these pages in a new tab, and Vercel may redirect between
// the apex and www hosts, which local storage does not cross. So a page asks
// the tab that opened it for the session, and accepts it only from a trusted
// player origin. The native app instead hands it over in the URL fragment.
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";
import type { PublicSurface } from "@/lib/surface";
import { consumeNativeSessionHandoff } from "@/lib/native-session-handoff";

// The player answers these message types by name, so they keep the
// "analytics" wording for every tool page.
const SESSION_REQUEST = "sj:analytics-session-request";
const SESSION_DELIVERY = "sj:analytics-session-delivery";

function isTrustedPlayerOrigin(origin: string, brand: PublicSurface) {
  return origin === window.location.origin
    || brand.origins.includes(origin)
    || origin === "https://sufferingjukebox.stream"
    || origin === "https://www.sufferingjukebox.stream"
    || origin === "https://listeningparty.stream"
    || origin === "https://www.listeningparty.stream";
}

export function useJukeboxSession(brand: PublicSurface) {
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [fromNativeApp, setFromNativeApp] = useState(false);

  useEffect(() => {
    let active = true;
    async function applySession(session: Session | null) {
      if (!active) return;
      setSignedIn(!!session?.user);
      setAccessToken(session?.access_token || "");
      setSessionReady(true);
    }
    const receiveSession = async (event: MessageEvent) => {
      if (event.source !== window.opener || !isTrustedPlayerOrigin(event.origin, brand)) return;
      if (event.data?.type !== SESSION_DELIVERY) return;
      const nextAccess = String(event.data.accessToken || "");
      const refreshToken = String(event.data.refreshToken || "");
      if (!nextAccess || !refreshToken) return;
      const { data, error } = await sjBrowserAuth.auth.setSession({ access_token: nextAccess, refresh_token: refreshToken });
      if (!error) {
        await applySession(data.session);
        window.opener = null;
      }
    };
    window.addEventListener("message", receiveSession);
    consumeNativeSessionHandoff().then((handoff) => {
      if (handoff?.fromNativeApp) setFromNativeApp(true);
      if (handoff) void applySession(handoff.session);
      else sjBrowserAuth.auth.getSession().then(({ data: { session } }) => { void applySession(session); });
    });
    const { data: { subscription } } = sjBrowserAuth.auth.onAuthStateChange((_event, session) => { void applySession(session); });
    try {
      const openerOrigin = document.referrer ? new URL(document.referrer).origin : "";
      if (window.opener && isTrustedPlayerOrigin(openerOrigin, brand)) {
        window.opener.postMessage({ type: SESSION_REQUEST }, openerOrigin);
      }
    } catch { /* No trusted opener session is available. */ }
    return () => { active = false; window.removeEventListener("message", receiveSession); subscription.unsubscribe(); };
  }, [brand]);

  return { sessionReady, signedIn, accessToken, fromNativeApp };
}
