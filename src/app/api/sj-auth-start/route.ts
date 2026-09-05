import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The native sign-in sheet exists only to put a recognisable name on Apple's
// consent alert. ASWebAuthenticationSession names the host of the URL it is
// handed, and that used to be the Supabase project URL, so the app asked to use
// "ntyvtpimesfoesuykuyi.supabase.co" - a string with nothing in it a listener
// could recognise. Starting the flow here instead means the alert names this
// site, and one 302 later the user is on the very same Supabase authorize URL.
//
// Nothing else about the flow moves: PKCE verifier stays in the client, the
// callback still comes back on the app's custom scheme, and the redirect is
// followed inside the sheet without a visible stop here.
const SUPABASE_AUTH_HOST = "ntyvtpimesfoesuykuyi.supabase.co";
const AUTHORIZE_PATH = "/auth/v1/authorize";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("to") || "";

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Bad url" }, { status: 400 });
  }

  // Pinned to the one endpoint this is for. Anything looser is an open redirect
  // wearing the site's own domain, which is exactly the trust this route trades on.
  if (
    target.protocol !== "https:" ||
    target.hostname.toLowerCase() !== SUPABASE_AUTH_HOST ||
    target.pathname !== AUTHORIZE_PATH
  ) {
    return NextResponse.json({ error: "Destination not allowed" }, { status: 400 });
  }

  return NextResponse.redirect(target.toString(), {
    status: 302,
    headers: {
      // An authorize URL carries single-use state; a cached hop would replay it.
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
