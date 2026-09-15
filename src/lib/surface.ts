// Johnny Outlaw, LLC — one codebase, two brands.
//
// Suffering Jukebox and Listening Party are the SAME application reading the
// SAME `jukebox` schema. They differ only in what they are called and which
// front door they open on: SJ leads with artists, LP leads with playlists.
//
// This file is the single source of truth for that difference. A brand string
// or a product-shape decision belongs here, never inline in a route or in
// public/index.html — the whole point is that the two surfaces cannot drift
// apart the way a fork would.
//
// Resolution order is env var, then hostname, then Suffering Jukebox. The
// hostname fallback is what makes localhost and Vercel preview deploys work
// without setting anything.

export type SurfaceId = "sj" | "lp";

export interface SurfaceFeatures {
  /** /<slug> serves an indexable artist page with catalog text and JSON-LD. */
  artistPages: boolean;
  /**
   * The Explore Artists landing tab, and clicking an artist opens the artist
   * discography view (charts, albums, tracks).
   */
  artistJukebox: boolean;
  /** The Explore Songs landing tab. */
  exploreSongs: boolean;
  /**
   * A Home landing tab in front of Explore Playlists: welcome copy, featured
   * picks, listening chart and import doors. Listening Party leads with this;
   * Suffering Jukebox keeps the artist wall as its front door.
   */
  homeTab: boolean;
  /** Which landing tab a first-time visitor lands on. */
  defaultLandingTab: "home" | "explore" | "playlists";
  /**
   * Explore Playlists comes before Explore Artists and Explore Songs in the tab
   * strip. Listening Party leads with playlists; Suffering Jukebox with artists.
   */
  playlistsFirst: boolean;
  /** The nightly per-artist share-image pipeline and the /share pages. */
  shareImages: boolean;
  /**
   * Three featured playlists on the Home tab (or above the playlist explorer
   * when there is no Home). A brand that leads with artists has a wall of
   * artists to lead with and does not need one.
   */
  welcomeHero: boolean;
  /**
   * On a phone: a Home / Explore / Create / You tab bar along the bottom edge,
   * with the docked player resting on top of it as one slim bar (artwork, song,
   * play/pause) that opens the full screen player on a tap or a swipe up.
   * Off, the phone dock keeps its quarter-screen sheet and the top tab strip.
   */
  phoneMiniPlayer: boolean;
  /**
   * Import from Spotify: connect an account and bring Liked Songs or a
   * playlist across. Off, every door to the wizard is hidden and
   * openSpotifyImport() refuses, so a stale ?spotify= return cannot open it.
   */
  spotifyImport: boolean;
  /**
   * Artist licensing for public mobile background play: /artist-upload,
   * /artist-agreement and the Publish My Music buttons. Off, both pages
   * redirect home and the buttons are hidden. Personal audio uploads are a
   * different feature and are not affected.
   */
  artistUpload: boolean;
  /**
   * A Live Stations landing tab that appears next to Explore Songs whenever
   * at least one Online Jukebox is on air. Listening Party only — Suffering
   * Jukebox already surfaces the same rooms as Live Now cards on Explore
   * Playlists.
   */
  liveStations: boolean;
  /**
   * List public /p/<slug> playlist pages in the sitemap. On for both brands:
   * the pages are real, indexable MusicPlaylist documents and Google will not
   * find them without a listing (or a crawl path that reaches them).
   */
  sitemapPlaylists: boolean;
}

export interface Surface {
  id: SurfaceId;
  /**
   * Inject the crawlable brand blurb on the home page (artist-jukebox brands
   * only). Listening Party has no artist wall to point at, so it stays off.
   */
  artistHomeSeo: boolean;
  /** Product name as a person would say it. */
  name: string;
  /** Canonical origin, no trailing slash. */
  url: string;
  /** Bare apex host, for share links and origin checks. */
  host: string;
  /** Every origin the browser may legitimately be running on. */
  origins: string[];
  /** <title> on the home page. */
  title: string;
  /** <meta name="description"> on the home page. */
  description: string;
  ogDescription: string;
  twitterDescription: string;
  /**
   * Installed-app description. Kept apart from the social copy because the
   * two are written for different readers and SJ's was already in the wild.
   */
  manifestDescription: string;
  keywords: string;
  tagline: string;
  /**
   * Text shown beside the header mark when the brand has no wordmark.
   * Empty for Suffering Jukebox (the wordmark already says the name).
   */
  headerTitle: string;
  /**
   * Prefix for this brand's static art under public/. Empty for Suffering
   * Jukebox, whose files sit at the root and must keep sitting there: they are
   * plain static assets on the CDN and routing them through a handler to gain
   * nothing would cost every visitor a hop.
   */
  assetBase: string;
  /** Absolute-from-root path to the wordmark. */
  textLogo: string;
  /** Absolute URL of the social card. */
  ogImage: string;
  /**
   * Real pixel size of that card. Declaring 1200x630 over a square app icon
   * tells a scraper to lay out a wide card and then hands it a small square,
   * so this travels with the image rather than being assumed.
   */
  ogImageSize: { w: number; h: number };
  /** Browser chrome colour. Not the UI accent - see `accent`. */
  themeColor: string;
  /**
   * The UI accent, which is a different job from themeColor. Listening Party's
   * mark is a deep purple that works as a tile behind white artwork and would
   * be nearly invisible as a highlight on a near-black page, so its accent is
   * the orange from the same logo instead.
   */
  accent: string;
  accentHover: string;
  /** The accent as "r,g,b" so CSS can build rgba() at any alpha. */
  accentRgb: string;
  /**
   * Extra Google Fonts stylesheet the brand's own lettering needs, loaded in
   * the head before first paint. Null for Suffering Jukebox, which gets by on
   * the fonts public/index.html already requests.
   */
  fontsHref: string | null;
  /** Custom URL scheme the native shell signs in through. */
  authScheme: string;
  /** Sentence used when sharing the site itself. */
  shareText: string;
  /** Subreddit for the share sheet, or null to drop that button. */
  redditSub: string | null;
  /**
   * The other brand on the same account (Integrations). Handed to the browser
   * so the dashboard never has to name the sister site in its own source.
   */
  sisterName: string;
  sisterUrl: string;
  /** Home-page structured data. Null leaves whatever the HTML already carries. */
  homeJsonLd: Record<string, unknown> | null;
  features: SurfaceFeatures;
}

const SJ_URL = "https://www.sufferingjukebox.stream";
const LP_URL = "https://listeningparty.stream";

export const SURFACES: Record<SurfaceId, Surface> = {
  sj: {
    id: "sj",
    artistHomeSeo: true,
    name: "Suffering Jukebox",
    url: SJ_URL,
    host: "sufferingjukebox.stream",
    origins: ["https://sufferingjukebox.stream", SJ_URL],
    title: "Suffering Jukebox | Free Online Music Player (sufferingjukebox.stream)",
    description:
      "Suffering Jukebox is the free website and online music player at sufferingjukebox.stream. Stream 170+ artists with lyrics, ratings, and playlists — including Silver Jews and Purple Mountains. Named after the Silver Jews song; this page is the app, not the track. No account needed to listen.",
    ogDescription:
      "The free Suffering Jukebox website at sufferingjukebox.stream. Stream 170+ artists, read lyrics, rate tracks, and build playlists — including Silver Jews and Purple Mountains.",
    twitterDescription:
      "The free Suffering Jukebox website and music player at sufferingjukebox.stream. Stream artists, read lyrics, build playlists — no account required.",
    manifestDescription:
      "Stream Silver Jews and Purple Mountains. A David Berman music player with ratings, lyrics, and playlists.",
    keywords:
      "Suffering Jukebox, sufferingjukebox.stream, Suffering Jukebox website, Suffering Jukebox app, Suffering Jukebox online, free online music player, free jukebox, online jukebox, free music player with lyrics, Silver Jews, Purple Mountains, David Berman, stream music free, artist jukebox, lyrics",
    tagline: "Explore an artist, one song at a time.",
    headerTitle: "",
    assetBase: "",
    textLogo: "/suffering-jukebox-text-logo.png",
    ogImage: `${SJ_URL}/og-image.png`,
    ogImageSize: { w: 1200, h: 630 },
    themeColor: "#ff6b35",
    accent: "#ff6b35",
    accentHover: "#ff8555",
    accentRgb: "255,107,53",
    fontsHref: null,
    authScheme: "com.johnnyoutlaw.sufferingjukebox",
    shareText:
      "Suffering Jukebox - explore Silver Jews & Purple Mountains with play counts, ratings, and lyrics.",
    redditSub: "sufferingjukebox",
    sisterName: "Listening Party",
    sisterUrl: `${LP_URL}/`,
    // Head JSON-LD lives in public/index.html so the SJ rewrite stays an
    // identity. Keep this null; change the block in the HTML instead.
    homeJsonLd: null,
    features: {
      artistPages: true,
      artistJukebox: true,
      exploreSongs: true,
      homeTab: false,
      defaultLandingTab: "explore",
      playlistsFirst: false,
      shareImages: true,
      sitemapPlaylists: true,
      welcomeHero: false,
      phoneMiniPlayer: false,
      spotifyImport: true,
      artistUpload: true,
      liveStations: false,
    },
  },

  lp: {
    id: "lp",
    artistHomeSeo: false,
    name: "Listening Party",
    url: LP_URL,
    host: "listeningparty.stream",
    origins: [LP_URL, "https://www.listeningparty.stream"],
    title: "Listening Party — Build, Share and Play Playlists",
    description:
      "Listening Party is a free online playlist player. Build a playlist from anything on YouTube, share it with a link, read the words as they play, and listen together in a room. No account needed to listen.",
    ogDescription:
      "Build a playlist from anything on YouTube, share it with a link, and listen together. Free, with lyrics, ratings and listening stats.",
    twitterDescription:
      "Build a playlist, share it with a link, listen together. No account required to listen.",
    manifestDescription:
      "Build a playlist from anything on YouTube, share it with a link, and listen together.",
    keywords:
      "playlist player, free online playlist, share a playlist, listening party, youtube playlist player, listen together, playlist with lyrics, free music player",
    tagline: "Join the Listening Party",
    // Header uses the circular badge plus live HTML title/tagline. The wide
    // lockup (header-mark.png) still paints both into one PNG, but at header
    // height the baked-in tagline collapses to a few pixels and cannot be
    // read. Live type stays legible at any size; keep the lockup for og cards.
    headerTitle: "ListeningParty.stream",
    assetBase: "/brand/lp",
    // Header mark is the monkey alone (no ring text). The full badge with
    // ListeningParty.Stream / JOIN THE LISTENING PARTY stays on favicons and
    // square cards; the wide lockup lives at header-mark.png for social cards.
    textLogo: "/brand/lp/listening-party-mark.png",
    ogImage: `${LP_URL}/brand/lp/og-image.png`,
    ogImageSize: { w: 1200, h: 630 },
    themeColor: "#4A1B6D",
    // The logo's orange. The plum ground and cream type that go with it live
    // in the html[data-surface="lp"] block of public/index.html.
    accent: "#FF5E14",
    accentHover: "#FF7A3A",
    accentRgb: "255,94,20",
    fontsHref:
      "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Figtree:wght@400;500;600;700;800&family=Lilita+One&display=swap",
    authScheme: "com.johnnyoutlaw.listeningparty",
    shareText:
      "Listening Party - build a playlist from anything on YouTube, share it with a link, and listen together.",
    redditSub: null,
    sisterName: "Suffering Jukebox",
    sisterUrl: `${SJ_URL}/`,
    homeJsonLd: {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Listening Party",
      alternateName: ["Free Online Playlist Player", "Listen Together"],
      url: `${LP_URL}/`,
      description:
        "Free online playlist player. Build a playlist from anything on YouTube, share it with a link, read the words as they play, and listen together.",
      applicationCategory: "MusicApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires JavaScript and HTML5",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    features: {
      artistPages: false,
      artistJukebox: true,
      exploreSongs: true,
      homeTab: true,
      defaultLandingTab: "home",
      playlistsFirst: true,
      shareImages: false,
      sitemapPlaylists: true,
      welcomeHero: true,
      phoneMiniPlayer: true,
      spotifyImport: false,
      artistUpload: false,
      liveStations: true,
    },
  },
};

export const DEFAULT_SURFACE: SurfaceId = "sj";

function isSurfaceId(v: string | undefined | null): v is SurfaceId {
  return v === "sj" || v === "lp";
}

/**
 * Which brand is this hostname? Matches the apex, the www form and any
 * subdomain of it, so preview and staging hosts resolve too. Unknown hosts
 * (a vercel.app preview URL, localhost) return null so the caller falls back.
 */
export function surfaceFromHost(host: string | null | undefined): Surface | null {
  const h = (host || "").toLowerCase().split(":")[0].trim();
  if (!h) return null;
  for (const s of Object.values(SURFACES)) {
    if (h === s.host || h === `www.${s.host}` || h.endsWith(`.${s.host}`)) return s;
  }
  return null;
}

/**
 * The surface this request is being served as. SURFACE_ID is what the two
 * Vercel projects actually differ by; the host check is the safety net for
 * local dev and preview deploys, which carry no env var of their own.
 */
export function currentSurface(host?: string | null): Surface {
  const env = process.env.SURFACE_ID?.trim().toLowerCase();
  if (isSurfaceId(env)) return SURFACES[env];
  return surfaceFromHost(host) ?? SURFACES[DEFAULT_SURFACE];
}

/** Every origin either brand may be served from — used by frame/postMessage checks. */
export function allSurfaceOrigins(): string[] {
  return Object.values(SURFACES).flatMap((s) => s.origins);
}

/**
 * The shape handed to the browser as window.__SURFACE__. Deliberately a
 * subset: the client has no business knowing about the other brand, and a
 * smaller blob is a smaller thing to keep in step with public/index.html.
 */
export function publicSurface(s: Surface) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    host: s.host,
    origins: s.origins,
    tagline: s.tagline,
    headerTitle: s.headerTitle,
    textLogo: s.textLogo,
    /** 192px app icon, for the lock screen and anywhere the client needs art. */
    icon: `${s.assetBase}/favicon.png`,
    themeColor: s.themeColor,
    accent: s.accent,
    accentHover: s.accentHover,
    accentRgb: s.accentRgb,
    authScheme: s.authScheme,
    shareText: s.shareText,
    redditSub: s.redditSub,
    sisterName: s.sisterName,
    sisterUrl: s.sisterUrl,
    // Only the flags the browser actually acts on. A server-only decision
    // (sitemapPlaylists) has no business in the page, and listing them
    // explicitly means adding one later cannot silently oblige the dashboard
    // to grow a matching default.
    features: {
      artistPages: s.features.artistPages,
      artistJukebox: s.features.artistJukebox,
      exploreSongs: s.features.exploreSongs,
      homeTab: s.features.homeTab,
      defaultLandingTab: s.features.defaultLandingTab,
      playlistsFirst: s.features.playlistsFirst,
      shareImages: s.features.shareImages,
      welcomeHero: s.features.welcomeHero,
      phoneMiniPlayer: s.features.phoneMiniPlayer,
      spotifyImport: s.features.spotifyImport,
      artistUpload: s.features.artistUpload,
      liveStations: s.features.liveStations,
    },
  };
}

export type PublicSurface = ReturnType<typeof publicSurface>;
