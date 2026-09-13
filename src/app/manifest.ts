import type { MetadataRoute } from "next";
import { currentSurface } from "@/lib/surface";

// Was a static public/manifest.webmanifest, which could only ever describe one
// brand. Next serves this at the same /manifest.webmanifest the head asks for.
export default function manifest(): MetadataRoute.Manifest {
  const s = currentSurface();
  const icon = `${s.assetBase}/favicon.png`;
  return {
    name: s.name,
    short_name: s.name,
    description: s.manifestDescription,
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: s.themeColor,
    icons: [
      { src: icon, sizes: "192x192", type: "image/png" },
      { src: icon, sizes: "512x512", type: "image/png" },
    ],
    // "Share -> Listening Party" from the YouTube app lands in the Add music box
    // (consumeSharedImport in public/index.html). Only works once installed.
    share_target: {
      action: "/",
      method: "GET",
      params: { title: "shared_title", text: "shared_text", url: "shared_url" },
    },
    categories: ["music", "entertainment"],
    lang: "en-US",
  };
}
