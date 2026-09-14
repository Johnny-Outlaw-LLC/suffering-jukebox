import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { currentSurface } from "@/lib/surface";

export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host");
  const s = currentSurface(host);
  const icon32 = s.assetBase ? `${s.assetBase}/favicon-32.png` : "/favicon-32.png";
  const icon = s.assetBase ? `${s.assetBase}/favicon.png` : "/favicon.png";
  return {
    title: `My Data & Analytics | ${s.name}`,
    icons: {
      icon: [
        { url: icon32, type: "image/png", sizes: "32x32" },
        { url: icon, type: "image/png", sizes: "192x192" },
      ],
      apple: [{ url: icon }],
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const host = (await headers()).get("host");
  return { themeColor: currentSurface(host).themeColor };
}

export default async function AnalyticsLayout({ children }: { children: ReactNode }) {
  const host = (await headers()).get("host");
  const s = currentSurface(host);
  return (
    <>
      {s.fontsHref ? <link rel="stylesheet" href={s.fontsHref} /> : null}
      {children}
    </>
  );
}
