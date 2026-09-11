import type { NextRequest } from "next/server";
import { servePublicHtmlFor } from "@/lib/serve-html";
import { currentSurface } from "@/lib/surface";

export async function GET(req: NextRequest) {
  const surface = currentSurface(req.headers.get("host"));
  // The home page is the one place that states the brand outright, so it takes
  // its copy from the surface rather than from whatever index.html was authored
  // with. Canonical lives in the HTML so the SJ head rewrite stays an identity;
  // brandTokens rewrite the host for Listening Party.
  return servePublicHtmlFor(surface, ["index.html"], {
    homeSeo: true,
    overrides: {
      title: surface.title,
      description: surface.description,
      ogDescription: surface.ogDescription,
      twitterDescription: surface.twitterDescription,
      keywords: surface.keywords,
      url: `${surface.url}/`,
      image: surface.ogImage,
      jsonLd: surface.homeJsonLd,
    },
  });
}
