import { NextResponse, type NextRequest } from "next/server";
import { RESERVED_SLUGS } from "@/lib/jukebox";
import { currentSurface } from "@/lib/surface";

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
const NATIVE_ORIGINS = new Set([
  "capacitor://www.sufferingjukebox.stream",
  "https://app.listeningparty.stream",
]);

function withNativeCors(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin");
  if (!origin || !NATIVE_ORIGINS.has(origin)) return response;
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "authorization, content-type, apikey, x-client-info");
  response.headers.set("Access-Control-Max-Age", "86400");
  response.headers.set("Vary", "Origin");
  return response;
}

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

// Listening Party gives playlists AND artists the root address
// (listeningparty.stream/nouns-group). A playlist keeps any name it already
// has, so links already shared never change meaning; anything else that names
// a public artist goes to the artist page. Cached for a minute and fails open
// to the old behaviour (the playlist route), which redirects home if unknown.
let lpSlugCache: { playlists: Set<string>; artists: Set<string> } | null = null;
let lpSlugCacheAt = 0;
let lpSlugInFlight: Promise<{ playlists: Set<string>; artists: Set<string> } | null> | null = null;

async function lpRootSlugs() {
  if (lpSlugCache && Date.now() - lpSlugCacheAt < SLUG_TTL_MS) return lpSlugCache;
  if (lpSlugInFlight) return lpSlugInFlight;
  lpSlugInFlight = (async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!key) return lpSlugCache;
    const headers = { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "jukebox" };
    try {
      const [pl, ar] = await Promise.all([
        fetch(`${REST}/playlists?select=slug&slug=not.is.null`, { headers, cache: "no-store" }),
        fetch(`${REST}/artists?select=slug&slug=not.is.null&visibility=eq.public`, { headers, cache: "no-store" }),
      ]);
      if (!pl.ok || !ar.ok) return lpSlugCache;
      const set = (rows: { slug: string | null }[]) =>
        new Set(rows.map((r) => (r.slug ?? "").toLowerCase()).filter(Boolean));
      lpSlugCache = { playlists: set(await pl.json()), artists: set(await ar.json()) };
      lpSlugCacheAt = Date.now();
      return lpSlugCache;
    } catch {
      return lpSlugCache;
    } finally {
      lpSlugInFlight = null;
    }
  })();
  return lpSlugInFlight;
}

/** Where a Listening Party root slug goes: the playlist route, or the artist page. */
export function lpRootTarget(
  slug: string,
  slugs: { playlists: Set<string>; artists: Set<string> } | null,
): "playlist" | "artist" {
  if (!slugs) return "playlist";
  if (slugs.playlists.has(slug)) return "playlist";
  return slugs.artists.has(slug) ? "artist" : "playlist";
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

  if (pathname.startsWith("/api/") && request.method === "OPTIONS") {
    return withNativeCors(request, new NextResponse(null, { status: 204 }));
  }

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
  const isVanityRoom = !!slug && (await vanitySlugs()).has(slug);
  if (slug && isVanityRoom) {
    const to = request.nextUrl.clone();
    to.pathname = "/";
    to.searchParams.set("live", slug);
    response = NextResponse.rewrite(to);
    response.cookies.set("sj_live_room", slug, { maxAge: 120, path: "/", sameSite: "lax", secure: true });
  } else if (slug && currentSurface(request.headers.get("host")).features.playlistsFirst
    && lpRootTarget(slug, await lpRootSlugs()) === "playlist") {
    // A playlist's clean root address. Rewrite internally to the shared
    // playlist route while leaving /my-playlist in the browser address bar.
    // An artist slug falls through to /[slug], which serves the artist.
    const to = request.nextUrl.clone();
    to.pathname = `/p/${slug}`;
    response = NextResponse.rewrite(to);
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
  return pathname.startsWith("/api/") ? withNativeCors(request, response) : response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
