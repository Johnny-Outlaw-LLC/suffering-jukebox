import { headers } from "next/headers";
import { currentSurface, publicSurface } from "@/lib/surface";
import AnalyticsClient from "./analytics-client";

export default async function AnalyticsPage() {
  const host = (await headers()).get("host");
  const brand = publicSurface(currentSurface(host));
  return <AnalyticsClient brand={brand} />;
}
