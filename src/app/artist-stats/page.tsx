import { headers } from "next/headers";
import { currentSurface, publicSurface } from "@/lib/surface";
import ArtistStatsClient from "./artist-stats-client";

export default async function ArtistStatsPage() {
  const host = (await headers()).get("host");
  const brand = publicSurface(currentSurface(host));
  return <ArtistStatsClient brand={brand} />;
}
