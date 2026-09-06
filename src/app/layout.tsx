import type { Metadata } from "next";

// The same tab icon the dashboard, /help and /about serve. This used to be a
// drawn-from-scratch record-and-jukebox SVG, which meant the React pages sat
// in the browser under a different logo from the rest of the site.
export const metadata: Metadata = {
  icons: {
    icon: [
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/favicon.png" }],
  },
};

// Root layout. Note that almost every entry under src/app is a route.ts that
// serves the static dashboard and never passes through here — this layout only
// wraps the real React pages, which today means the Interactive Jukebox guest
// app at /j/<code>.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body style={{ margin: 0, background: "#0a0a0a" }}>{children}</body>
    </html>
  );
}
