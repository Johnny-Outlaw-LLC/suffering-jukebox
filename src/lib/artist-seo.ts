/**
 * Crawlable catalog text + JSON-LD for public artist jukebox pages.
 * The SPA still drives the player; this is what search engines and AI crawlers
 * read from the first HTML response (song titles and lyrics as real text).
 */
import { SITE_NAME, SITE_URL } from "@/lib/site";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

export type SeoArtist = {
  id: string;
  name: string;
  slug: string;
  visibility?: string | null;
  added_by_name?: string | null;
};

export type SeoAlbum = {
  id: string;
  name: string;
  release_date?: string | null;
};

export type SeoTrack = {
  id: string;
  name: string;
  album_id: string;
  track_number?: number | null;
};

export type SeoCatalog = {
  albums: SeoAlbum[];
  tracks: SeoTrack[];
  lyricsByTrack: Record<string, string>;
};

export const esc = (s: string) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Drop LRC timestamps so crawlers index the words, not [00:12.00] noise. */
export function plainLyrics(raw: string): string {
  return String(raw || "")
    .replace(/^\s*\[[^\]]*\]\s*/gm, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function sb<T>(path: string, revalidate = 3600): Promise<T[]> {
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

async function sbPages<T>(path: string, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    try {
      const r = await fetch(`${REST}${path}`, {
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${ANON}`,
          "Accept-Profile": "jukebox",
          Range: `${offset}-${offset + pageSize - 1}`,
          Prefer: "count=exact",
        },
        next: { revalidate: 3600 },
      });
      if (!r.ok) break;
      const page = (await r.json()) as T[];
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    } catch {
      break;
    }
  }
  return out;
}

/** Public artists only — private imports must not be indexed. */
export async function fetchPublicArtistBySlug(slug: string): Promise<SeoArtist | null> {
  const rows = await sb<SeoArtist>(
    `/artists?slug=eq.${encodeURIComponent(slug)}&select=id,name,slug,visibility,added_by_name&or=(visibility.eq.public,visibility.is.null)`
  );
  return rows[0] || null;
}

export async function fetchArtistCatalog(artistId: string): Promise<SeoCatalog> {
  const albums = await sb<SeoAlbum>(
    `/albums?artist_id=eq.${artistId}&select=id,name,release_date&order=release_date.asc`
  );
  if (!albums.length) return { albums: [], tracks: [], lyricsByTrack: {} };

  const albumIds = albums.map((a) => a.id);
  const tracks: SeoTrack[] = [];
  for (let i = 0; i < albumIds.length; i += 40) {
    const chunk = albumIds.slice(i, i + 40);
    const rows = await sbPages<SeoTrack>(
      `/tracks?album_id=in.(${chunk.join(",")})&select=id,name,album_id,track_number&order=album_id,track_number`
    );
    tracks.push(...rows);
  }

  const lyricsByTrack: Record<string, string> = {};
  const ids = tracks.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = await sb<{ track_id: string; lyrics: string }>(
      `/lyrics?track_id=in.(${chunk.join(",")})&select=track_id,lyrics`
    );
    for (const row of rows) {
      const plain = plainLyrics(row.lyrics || "");
      if (plain) lyricsByTrack[row.track_id] = plain;
    }
  }

  return { albums, tracks, lyricsByTrack };
}

export function artistPageDescription(name: string, trackCount: number, albumCount: number): string {
  const counts: string[] = [];
  if (albumCount) counts.push(`${albumCount} album${albumCount === 1 ? "" : "s"}`);
  if (trackCount) counts.push(`${trackCount} song${trackCount === 1 ? "" : "s"}`);
  return [
    `Free online ${name} music player and jukebox on ${SITE_NAME}.`,
    "Stream the catalog, read lyrics, build playlists, and explore play history.",
    counts.length ? `${counts.join(", ")} with titles and lyrics on the page for search.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildArtistJsonLd(
  artist: SeoArtist,
  catalog: SeoCatalog,
  pageUrl: string
): Record<string, unknown> {
  const name = (artist.name || "").trim();
  const byAlbum = new Map<string, SeoTrack[]>();
  for (const t of catalog.tracks) {
    if (!byAlbum.has(t.album_id)) byAlbum.set(t.album_id, []);
    byAlbum.get(t.album_id)!.push(t);
  }

  const albums = catalog.albums.map((al) => {
    const songs = byAlbum.get(al.id) || [];
    return {
      "@type": "MusicAlbum",
      name: al.name,
      byArtist: { "@type": "MusicGroup", name },
      datePublished: (al.release_date || "").slice(0, 4) || undefined,
      numTracks: songs.length || undefined,
      track: songs.slice(0, 40).map((t, i) => ({
        "@type": "MusicRecording",
        name: t.name,
        position: t.track_number || i + 1,
        byArtist: { "@type": "MusicGroup", name },
        url: pageUrl,
      })),
    };
  });

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": `${SITE_URL}/#app`,
        name: SITE_NAME,
        url: SITE_URL,
        applicationCategory: "MusicApplication",
        operatingSystem: "Any",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        description:
          "Free online music player and jukebox. Stream artists, read lyrics, rate songs, and build playlists.",
      },
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#page`,
        url: pageUrl,
        name: `${name} Jukebox | ${SITE_NAME}`,
        description: artistPageDescription(name, catalog.tracks.length, catalog.albums.length),
        isPartOf: { "@id": `${SITE_URL}/#app` },
        about: { "@id": `${pageUrl}#artist` },
        mainEntity: { "@id": `${pageUrl}#artist` },
      },
      {
        "@type": "MusicGroup",
        "@id": `${pageUrl}#artist`,
        name,
        url: pageUrl,
        album: albums,
      },
    ],
  };
}

/**
 * Real HTML (not canvas/JSON). Lives outside #main so the SPA can hide it
 * after boot without removing it from the first paint crawlers see.
 */
export function buildArtistCatalogHtml(
  artist: SeoArtist,
  catalog: SeoCatalog,
  pageUrl: string
): string {
  const name = (artist.name || "").trim();
  const byAlbum = new Map<string, SeoTrack[]>();
  for (const t of catalog.tracks) {
    if (!byAlbum.has(t.album_id)) byAlbum.set(t.album_id, []);
    byAlbum.get(t.album_id)!.push(t);
  }

  const albumBlocks = catalog.albums
    .map((al) => {
      const songs = byAlbum.get(al.id) || [];
      const year = (al.release_date || "").slice(0, 4);
      const trackItems = songs
        .map((t) => {
          const lyr = catalog.lyricsByTrack[t.id];
          const lyrBlock = lyr
            ? `<div class="sj-seo-lyrics"><h4>Lyrics: ${esc(t.name)}</h4><pre>${esc(lyr)}</pre></div>`
            : "";
          return `<li><strong>${esc(t.name)}</strong>${lyrBlock}</li>`;
        })
        .join("");
      return (
        `<section class="sj-seo-album">` +
        `<h2>${esc(al.name)}${year ? ` (${esc(year)})` : ""}</h2>` +
        `<ol>${trackItems || "<li>No tracks listed yet.</li>"}</ol>` +
        `</section>`
      );
    })
    .join("\n");

  const titleList = catalog.tracks.map((t) => esc(t.name)).join(", ");

  return (
    `<section id="sj-seo-catalog" class="sj-seo-catalog" data-artist-slug="${esc(artist.slug)}">` +
    `<h1>${esc(name)} — free online jukebox on ${esc(SITE_NAME)}</h1>` +
    `<p>${esc(name)} on ${esc(SITE_NAME)} is a free online music player. ` +
    `Stream every album, open the lyrics, rate tracks, and build playlists. ` +
    `Open the interactive player at <a href="${esc(pageUrl)}">${esc(pageUrl)}</a>.` +
    (artist.added_by_name ? ` Catalog added by ${esc(artist.added_by_name)}.` : "") +
    `</p>` +
    `<p><strong>Songs:</strong> ${titleList || "Catalog loading."}</p>` +
    `<p><a href="${esc(SITE_URL)}/share/${esc(artist.slug)}">${esc(name)} album charts</a> · ` +
    `<a href="${esc(SITE_URL)}">Explore more free artist jukeboxes</a> · ` +
    `<a href="${esc(SITE_URL)}/about">About ${esc(SITE_NAME)}</a></p>` +
    albumBlocks +
    `</section>`
  );
}
