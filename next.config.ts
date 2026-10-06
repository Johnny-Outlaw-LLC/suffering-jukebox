import path from "node:path";
import type { NextConfig } from "next";

// Deliberately conservative: these three CSP directives cannot break a
// resource load (no script-src / connect-src / img-src restrictions), but they
// do close clickjacking, plugin injection, and <base> hijacking. A full CSP
// would need script-src 'unsafe-inline' anyway, since the app is one big inline
// script, so it is left for a separate pass.
const CSP = [
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

// /yt-frame is the one route that must be framable by something other than
// this origin: the native shell runs on capacitor://www.sufferingjukebox.stream
// and embeds it to get a real https origin for the YouTube player. So it gets
// frame-ancestors naming that scheme, and no X-Frame-Options at all -
// SAMEORIGIN cannot express a custom scheme and WKWebView honours it.
const framableHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "frame-ancestors 'self' capacitor: https://www.sufferingjukebox.stream https://app.listeningparty.stream https://app.recordkeeper.stream",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

// Public fictional demos can be embedded in the Record Keeper guides.
// Authenticated dashboards retain SAMEORIGIN and the original CSP.
const demoHeaders = [
  ...framableHeaders.filter(h => h.key !== "Content-Security-Policy"),
  { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://outlawapps.online https://www.outlawapps.online http://localhost:3127; object-src 'none'; base-uri 'self'" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Album covers are stored under SJ paths in the shared catalog. LP does not
  // own the Backblaze bucket, so its local art handlers cannot serve them.
  // Resolve those paths through SJ before matching LP's filesystem routes.
  async rewrites() {
    return {
      beforeFiles: ["lp", "rk"].includes(process.env.SURFACE_ID?.trim().toLowerCase() || "")
        ? ["album-art", "artist-release-art"].map((segment) => ({
            source: `/${segment}/:path*`,
            destination: `https://www.sufferingjukebox.stream/${segment}/:path*`,
          }))
        : [],
      afterFiles: [],
      fallback: [],
    };
  },
  // The admin Test Coverage page reads test-results.json off disk through
  // /api/sj-admin-tests. It is deliberately not under public/ (that page is
  // restricted, and the report names every gap in the app), so tracing has to
  // be told about it or the standalone build ships without it.
  outputFileTracingIncludes: {
    "/api/sj-admin-tests": ["./test-results.json"],
  },
  // Local checkouts of this repo are git worktrees whose parent directory is
  // another copy of the repo, lockfile and all. Without this Next walks up,
  // picks the parent as the workspace root and serves its src/app instead.
  turbopack: { root: path.resolve(".") },
  async headers() {
    return [
      { source: "/yt-frame", headers: framableHeaders },
      { source: "/demo/:path*", headers: demoHeaders },
      { source: "/((?!yt-frame|demo/).*)", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
