import type { MetadataRoute } from "next";
import { currentSurface } from "@/lib/surface";

export default function robots(): MetadataRoute.Robots {
  const s = currentSurface();
  const disallow = ["/api/", "/artist-rights-admin"];
  // A brand with no artist jukebox has nothing behind these, and they would
  // otherwise offer a crawler the other brand's catalogue under this domain.
  if (!s.features.shareImages) disallow.push("/share");
  if (!s.features.artistJukebox) disallow.push("/community");

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow,
    },
    sitemap: `${s.url}/sitemap.xml`,
    host: s.url,
  };
}
