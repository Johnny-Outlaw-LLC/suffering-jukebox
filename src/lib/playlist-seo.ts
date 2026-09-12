/**
 * Crawlable track list + MusicPlaylist JSON-LD for public /p/<slug> pages.
 * Same idea as artist-seo.ts: the SPA still runs the player; this is what a
 * crawler reads from the first HTML response.
 */
import { SITE_NAME } from "@/lib/site";

const REST = "https://ntyvtpimesfoesuykuyi.supabase.co/rest/v1";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

export type SeoPlaylist = {
  id: string;
  name: string;
  slug: string;
  user_name?: string | null;
};

export type SeoPlaylistTrack = {
  id: string;
  name: string;
  artistName: string;
  position: number;
};

const esc = (s: string) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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

/** Ordered tracks with artist names for a playlist (capped for HTML size). */
export async function fetchPlaylistTracks(
  playlistId: string,
  limit = 200
): Promise<SeoPlaylistTrack[]> {
  const rows = await sb<{ track_id: string; position: number | null }>(
    `/playlist_tracks?playlist_id=eq.${encodeURIComponent(playlistId)}` +
      `&select=track_id,position&order=position.asc.nullslast&limit=${limit}`
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.track_id).filter(Boolean);
  const tracks = await sb<{
    id: string;
    name: string;
    albums: { artists: { name: string } | null } | null;
  }>(
    `/tracks?id=in.(${ids.map(encodeURIComponent).join(",")})` +
      `&select=id,name,albums(artists(name))`
  );
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const out: SeoPlaylistTrack[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = byId.get(row.track_id);
    if (!t) continue;
    out.push({
      id: t.id,
      name: (t.name || "").trim() || "Untitled",
      artistName: (t.albums?.artists?.name || "").trim(),
      position: row.position ?? i + 1,
    });
  }
  return out;
}

export function playlistPageDescription(
  name: string,
  by: string,
  trackCount: number
): string {
  const who = by ? ` by ${by}` : "";
  const n = trackCount > 0 ? ` ${trackCount} songs.` : "";
  return `Listen to ${name}${who} on ${SITE_NAME}, a free online music player and jukebox.${n} Stream the playlist, read lyrics, and rate songs.`;
}

export function buildPlaylistJsonLd(
  pl: SeoPlaylist,
  tracks: SeoPlaylistTrack[],
  pageUrl: string
): Record<string, unknown> {
  const name = (pl.name || "").trim();
  const by = (pl.user_name || "").trim();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#page`,
        url: pageUrl,
        name: `${name} Playlist | ${SITE_NAME}`,
        description: playlistPageDescription(name, by, tracks.length),
        isPartOf: { "@type": "WebSite", name: SITE_NAME, url: pageUrl.replace(/\/p\/.*$/, "") },
        mainEntity: { "@id": `${pageUrl}#playlist` },
      },
      {
        "@type": "MusicPlaylist",
        "@id": `${pageUrl}#playlist`,
        name,
        url: pageUrl,
        ...(by ? { author: { "@type": "Person", name: by } } : {}),
        numTracks: tracks.length,
        track: tracks.slice(0, 100).map((t, i) => ({
          "@type": "MusicRecording",
          name: t.name,
          position: t.position || i + 1,
          ...(t.artistName
            ? { byArtist: { "@type": "MusicGroup", name: t.artistName } }
            : {}),
        })),
      },
    ],
  };
}

/** Hidden-from-JS-listeners but present for crawlers, same pattern as artist pages. */
export function buildPlaylistCatalogHtml(
  pl: SeoPlaylist,
  tracks: SeoPlaylistTrack[],
  pageUrl: string
): string {
  const name = esc((pl.name || "").trim());
  const by = (pl.user_name || "").trim();
  const items = tracks
    .map((t, i) => {
      const label = t.artistName
        ? `${esc(t.artistName)} — ${esc(t.name)}`
        : esc(t.name);
      return `<li>${i + 1}. ${label}</li>`;
    })
    .join("\n");
  return (
    `<section id="sj-playlist-catalog" hidden aria-hidden="true">` +
    `<h1>${name} playlist</h1>` +
    `<p>${by ? `Curated by ${esc(by)} on ` : ""}${esc(SITE_NAME)}. ` +
    `<a href="${esc(pageUrl)}">Open this playlist</a>.</p>` +
    (items ? `<ol>\n${items}\n</ol>` : "<p>No tracks listed yet.</p>") +
    `</section>`
  );
}
