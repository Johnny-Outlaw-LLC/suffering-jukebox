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

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
