import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { currentSurface, publicSurface, SURFACES } from "@/lib/surface";
import DemoClient, { type DemoView } from "../demo-client";

export const metadata: Metadata = { title: "Interactive music demos", robots: { index: false, follow: false } };
const views = new Set(["artist-stats", "analytics", "catalog", "lyrics", "history"]);

export default async function DemoPage({ params, searchParams }: {
  params: Promise<{ view: string }>;
  searchParams: Promise<{ brand?: string; embed?: string }>;
}) {
  const [{ view }, query, hostHeaders] = await Promise.all([params, searchParams, headers()]);
  if (!views.has(view)) notFound();
  const brand = publicSurface(query.brand === "lp" || query.brand === "sj" ? SURFACES[query.brand] : currentSurface(hostHeaders.get("host")));
  const preview = query.brand === "rk";
  const demoBrand = preview ? {
    ...publicSurface(SURFACES.lp), name: "Record Keeper", url: "https://www.outlawapps.online/record-keeper",
    accent: "#ef8b63", accentHover: "#ff9b75", accentRgb: "239,139,99", themeColor: "#171717",
    textLogo: "https://www.outlawapps.online/record-keeper/wordmark-dark.png",
  } : brand;
  return <DemoClient view={view as DemoView} brand={demoBrand} embedded={query.embed === "1"} preview={preview} />;
}
