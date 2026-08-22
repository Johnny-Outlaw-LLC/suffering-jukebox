// Johnny Outlaw, LLC — Suffering Jukebox — share image manifest reads.
//
// jukebox.share_images is written nightly by the capture job (capture/) and is
// read-only to clients. Everything that needs a generated image — the artist
// page's og:image, the /share pages, the sitemap, the Export Image modal —
// reads it through here so the key layout lives in one place.
import { SITE_URL } from "@/lib/site";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

export type ShareImage = {
  slug: string;
  shot_id: string;
  format: "stage" | "reel" | "og";
  b2_key: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  album_count: number | null;
  track_count: number | null;
  captured_at: string;
};

/** Human labels for each view. Keep in step with ALL_SHOTS in capture/capture.mjs. */
export const SHOT_LABELS: Record<string, string> = {
  "byyear-collapsed": "By Year",
  "byyear-expanded": "By Year, tracks open",
  "timeline-collapsed": "Timeline",
  "byviews-collapsed": "By Views",
  alltracks: "All Tracks",
};

export const SHOT_ORDER = [
  "byyear-collapsed",
  "byviews-collapsed",
  "timeline-collapsed",
  "byyear-expanded",
  "alltracks",
];

/** Public URL on our own domain for a manifest row. */
export function shareImageUrl(row: Pick<ShareImage, "b2_key">): string {
  // b2_key is share/v1/<slug>/<file>
  const parts = row.b2_key.split("/");
  const file = parts[parts.length - 1];
  const slug = parts[parts.length - 2];
  return `${SITE_URL}/share-image/${slug}/${file}`;
}

async function sb<T>(path: string, revalidate = 900): Promise<T[]> {
  try {
    const r = await fetch(`${REST}${path}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Accept-Profile": "jukebox" },
      next: { revalidate },
    });
    if (!r.ok) return [];
    return (await r.json()) as T[];
  } catch {
    return [];
  }
}

/** Every generated image for one artist. */
export async function getShareImages(slug: string): Promise<ShareImage[]> {
  return sb<ShareImage>(
    `/share_images?slug=eq.${encodeURIComponent(slug)}` +
      `&select=slug,shot_id,format,b2_key,width,height,bytes,album_count,track_count,captured_at`,
  );
}

/** The 1200x630 card for an artist, or null if tonight's job has not made one. */
export async function getOgImage(slug: string): Promise<ShareImage | null> {
  const rows = await sb<ShareImage>(
    `/share_images?slug=eq.${encodeURIComponent(slug)}&format=eq.og` +
      `&select=slug,shot_id,format,b2_key,width,height,bytes,album_count,track_count,captured_at&limit=1`,
  );
  return rows[0] || null;
}

/** Slugs that have at least one generated image — what /share pages exist. */
export async function listSharedSlugs(): Promise<string[]> {
  const rows = await sb<{ slug: string }>(
    `/share_images?format=eq.og&select=slug&order=slug.asc&limit=1000`,
    3600,
  );
  return [...new Set(rows.map((r) => r.slug))];
}
