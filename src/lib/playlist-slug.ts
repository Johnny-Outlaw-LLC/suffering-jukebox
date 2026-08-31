// Vanity URLs for playlists: sufferingjukebox.stream/p/my-mix
// Prefixed with /p/ so they never fight artist or Online Jukebox bare slugs.

import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { RESERVED_SLUGS } from "@/lib/jukebox";

type Sj = ReturnType<typeof createSjServiceClient>;
const T = (sb: Sj, table: string) => sb.schema(JUKEBOX_SCHEMA).from(table);

export const PLAYLIST_SLUG_MIN = 3;
export const PLAYLIST_SLUG_MAX = 48;

export function slugifyPlaylistName(name: string): string {
  const base = (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PLAYLIST_SLUG_MAX);
  return base.length >= PLAYLIST_SLUG_MIN ? base : "playlist";
}

export function normalizePlaylistSlug(input: unknown): { ok: true; slug: string } | { ok: false; message: string } {
  if (typeof input !== "string") return { ok: false, message: "Type a web address." };
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/^p\//, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PLAYLIST_SLUG_MAX);
  if (slug.length < PLAYLIST_SLUG_MIN) {
    return { ok: false, message: `Use at least ${PLAYLIST_SLUG_MIN} letters or numbers.` };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, message: `"${slug}" is a page on this site already. Pick another.` };
  }
  return { ok: true, slug };
}

/** True when this slug is free across artists, rooms, and other playlists. */
export async function playlistSlugAvailable(
  sb: Sj,
  slug: string,
  exceptPlaylistId?: string | null,
): Promise<boolean> {
  const key = slug.toLowerCase();
  if (RESERVED_SLUGS.has(key)) return false;

  const [artist, room, playlist] = await Promise.all([
    T(sb, "artists").select("id").eq("slug", key).maybeSingle(),
    T(sb, "jukeboxes").select("id").ilike("public_slug", key).maybeSingle(),
    T(sb, "playlists").select("id").ilike("slug", key).maybeSingle(),
  ]);
  if (artist.error) throw artist.error;
  if (room.error) throw room.error;
  if (playlist.error) throw playlist.error;
  if (artist.data) return false;
  if (room.data) return false;
  if (playlist.data && playlist.data.id !== exceptPlaylistId) return false;
  return true;
}

export async function allocatePlaylistSlug(
  sb: Sj,
  name: string,
  exceptPlaylistId?: string | null,
): Promise<string> {
  const base = slugifyPlaylistName(name);
  for (let n = 0; n < 40; n++) {
    const candidate = n === 0 ? base : `${base.slice(0, Math.max(1, PLAYLIST_SLUG_MAX - 3 - String(n + 1).length))}-${n + 1}`;
    if (await playlistSlugAvailable(sb, candidate, exceptPlaylistId)) return candidate;
  }
  return `${base.slice(0, 32)}-${Date.now().toString(36)}`;
}

export async function ensurePlaylistSlug(
  sb: Sj,
  playlist: { id: string; name?: string | null; slug?: string | null },
): Promise<string> {
  const existing = (playlist.slug || "").trim().toLowerCase();
  if (existing && (await playlistSlugAvailable(sb, existing, playlist.id))) {
    return existing;
  }
  if (existing) {
    // Kept a stale slug that now collides — mint a fresh one.
  }
  const slug = await allocatePlaylistSlug(sb, playlist.name || "playlist", playlist.id);
  const { error } = await T(sb, "playlists").update({ slug }).eq("id", playlist.id);
  if (error) throw error;
  return slug;
}
