import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { shareImageUrl, type ShareImage } from "@/lib/share-images";

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
    {
      url: `${SITE_URL}/terms`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/dmca`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/artist-agreement`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/artist-upload`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/share`,
      lastModified,
      changeFrequency: "daily",
      priority: 0.7,
    },
  ];

  // Nightly chart images, grouped per artist. The `images` field emits proper
  // <image:image> entries, which is how Google Images finds them at all.
  const shotsBySlug = new Map<string, ShareImage[]>();
  try {
    const r = await fetch(
      `${REST}/share_images?format=eq.stage&select=slug,b2_key,captured_at&order=slug.asc&limit=2000`,
      {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
        next: { revalidate: 3600 },
      }
    );
    if (r.ok) {
      const rows: ShareImage[] = await r.json();
      for (const row of rows) {
        if (!shotsBySlug.has(row.slug)) shotsBySlug.set(row.slug, []);
        shotsBySlug.get(row.slug)!.push(row);
      }
    }
  } catch {
    /* artist pages still get listed below, just without image entries */
  }

  for (const [slug, rows] of shotsBySlug) {
    entries.push({
      url: `${SITE_URL}/share/${slug}`,
      lastModified: new Date(rows.map((r) => r.captured_at).sort().reverse()[0] || lastModified),
      changeFrequency: "daily",
      priority: 0.7,
      images: rows.map((r) => shareImageUrl(r)),
    });
  }

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
