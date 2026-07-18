import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const entries: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/community`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/about`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];

  // Community artist jukebox pages (/pavement etc.)
  try {
    const r = await fetch(
      `${REST}/artists?is_community=eq.true&slug=not.is.null&select=slug`,
      {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
        next: { revalidate: 3600 },
      }
    );
    if (r.ok) {
      const rows: Array<{ slug: string }> = await r.json();
      for (const { slug } of rows) {
        entries.push({
          url: `${SITE_URL}/${slug}`,
          lastModified,
          changeFrequency: "weekly",
          priority: 0.6,
        });
      }
    }
  } catch {
    /* static entries only */
  }

  return entries;
}
