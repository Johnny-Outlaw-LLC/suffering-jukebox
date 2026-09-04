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
      "frame-ancestors 'self' capacitor: https://www.sufferingjukebox.stream",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

// The native shell runs on capacitor://www.sufferingjukebox.stream, so every
// call it makes to /api is cross-origin and the browser blocks it without
// these. Scoped to that one exact origin, and no Allow-Credentials: the app
// authenticates with a bearer token, not cookies, so nothing rides along
// implicitly. A web page cannot forge an Origin header, so this grants nothing
// to anyone else.
const NATIVE_ORIGIN = "capacitor://www.sufferingjukebox.stream";

const apiCorsHeaders = [
  { key: "Access-Control-Allow-Origin", value: NATIVE_ORIGIN },
  { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, PUT, DELETE, OPTIONS" },
  { key: "Access-Control-Allow-Headers", value: "authorization, content-type, apikey, x-client-info" },
  { key: "Access-Control-Max-Age", value: "86400" },
  { key: "Vary", value: "Origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Local checkouts of this repo are git worktrees whose parent directory is
  // another copy of the repo, lockfile and all. Without this Next walks up,
  // picks the parent as the workspace root and serves its src/app instead.
  turbopack: { root: path.resolve(".") },
  async headers() {
    return [
      { source: "/yt-frame", headers: framableHeaders },
      { source: "/api/:path*", headers: apiCorsHeaders },
      { source: "/((?!yt-frame).*)", headers: securityHeaders },
    ];
  },
};

export default nextConfig;
