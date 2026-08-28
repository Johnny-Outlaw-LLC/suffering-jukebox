import { NextResponse, type NextRequest } from "next/server";
import { RESERVED_SLUGS } from "@/lib/jukebox";

// ── Vanity jukebox addresses ──────────────────────────────────────────────
// A host who has claimed one gets sufferingjukebox.stream/outlaw, not
// /j/ZPGZ4H. That has to be a rewrite rather than a redirect: the whole value
// of the short address is that it is still in the address bar when somebody
// looks over your shoulder.
//
// It happens here because /[slug] is a route handler serving the dashboard for
// artist pages, and /j/[code] is a React page — two different kinds of route
// that cannot share one path segment. The middleware picks between them before
// the router does.
//
// The list of claimed addresses is tiny (one row per host who bothered) and is
// cached for a minute, so an artist page costs a Set lookup and each instance
// costs one small query a minute. Anything that goes wrong fails open and the
// request carries on to /[slug] exactly as before.

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const SLUG_TTL_MS = 60_000;

let slugCache: Set<string> | null = null;
let slugCacheAt = 0;
let slugInFlight: Promise<Set<string>> | null = null;

async function vanitySlugs(): Promise<Set<string>> {
  if (slugCache && Date.now() - slugCacheAt < SLUG_TTL_MS) return slugCache;
  if (slugInFlight) return slugInFlight;

  slugInFlight = (async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!key) return slugCache ?? new Set<string>();
    try {
      const res = await fetch(`${REST}/jukeboxes?select=public_slug&public_slug=not.is.null`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Accept-Profile": "jukebox",
        },
        cache: "no-store",
      });
      if (!res.ok) return slugCache ?? new Set<string>();
      const rows = (await res.json()) as { public_slug: string | null }[];
      slugCache = new Set(rows.map((r) => (r.public_slug ?? "").toLowerCase()).filter(Boolean));
      slugCacheAt = Date.now();
      return slugCache;
    } catch {
      // Stale is better than broken: an artist page must not 500 because the
      // jukebox table was briefly unreachable.
      return slugCache ?? new Set<string>();
    } finally {
      slugInFlight = null;
    }
  })();

  return slugInFlight;
}

/** Single lowercase path segment, no file extension: the shape of a slug. */
function slugCandidate(pathname: string): string | null {
  const m = pathname.match(/^\/([a-z0-9][a-z0-9-]{1,39})\/?$/);
  if (!m) return null;
  const slug = m[1];
  if (RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response = NextResponse.next();
  // A room is rendered by the main application in its restricted room mode.
  // Keep the old printed /j/CODE cards working, but never send a visitor to a
  // second guest-only player implementation.
  const codeMatch = request.method === "GET" && pathname.match(/^\/j\/([a-z0-9-]{3,40})\/?$/i);
  if (codeMatch) {
    const to = request.nextUrl.clone();
    to.pathname = "/";
    to.searchParams.set("live", codeMatch[1]);
    response = NextResponse.rewrite(to);
    response.cookies.set("sj_live_room", codeMatch[1], { maxAge: 120, path: "/", sameSite: "lax", secure: true });
  }
  const slug = request.method === "GET" ? slugCandidate(pathname) : null;
  if (slug && (await vanitySlugs()).has(slug)) {
    const to = request.nextUrl.clone();
    to.pathname = "/";
    to.searchParams.set("live", slug);
    response = NextResponse.rewrite(to);
    response.cookies.set("sj_live_room", slug, { maxAge: 120, path: "/", sameSite: "lax", secure: true });
  }

  const navRef = request.headers.get("referer") || request.headers.get("referrer");
  if (navRef && request.method === "GET" && !pathname.startsWith("/api")) {
    response.cookies.set("sj_nav_referrer", navRef, {
      maxAge: 180,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
