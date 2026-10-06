// Who may change an artist's catalogue. The community-import edge function has
// the same rule; this is the copy the Next routes share so the two cannot
// drift apart within this repo.
import { createSjServiceClient, isSjAdmin, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

/** Artists whose catalogue Johnny Outlaw maintains although they are not community imports. */
export const OFFICIAL_MANAGE_SLUGS = new Set(["silver-jews", "purple-mountains"]);
export const OFFICIAL_OWNER = "johnnyoutlawllc@gmail.com";

export async function canManageArtist(
  sb: ReturnType<typeof createSjServiceClient>,
  email: string,
  artistId: string,
): Promise<boolean> {
  const e = (email || "").toLowerCase();
  if (await isSjAdmin(email)) return true;
  const { data: artist } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id, added_by, slug, is_community")
    .eq("id", artistId)
    .maybeSingle();
  if (!artist) return false;
  if ((artist.added_by || "").toLowerCase() === e) return true;
  if (OFFICIAL_MANAGE_SLUGS.has(artist.slug || "") && e === OFFICIAL_OWNER) return true;
  // A later importer gets a content_access row, which is enough to fine-tune
  // the catalogue without taking over the artists.added_by credit.
  const { data: access } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("content_access")
    .select("artist_id")
    .eq("artist_id", artistId)
    .eq("user_email", e)
    .maybeSingle();
  return !!access;
}

/**
 * Who may read an artist's stats: anyone who can manage the catalogue, plus
 * the people who brought the music in as the artist (the uploader of a direct
 * release, an upload grant, or an approved rights agreement). The stats are
 * aggregates, but they are still the artist's business, not the public's.
 */
export async function canViewArtistStats(
  sb: ReturnType<typeof createSjServiceClient>,
  user: { id: string; email?: string | null },
  artistId: string,
): Promise<boolean> {
  const email = (user.email || "").toLowerCase();
  if (email && (await canManageArtist(sb, email, artistId))) return true;
  const ids = await artistIdsAsArtist(sb, user);
  return ids.has(artistId);
}

/** Artist ids the user is connected to as the artist, not as an importer. */
async function artistIdsAsArtist(
  sb: ReturnType<typeof createSjServiceClient>,
  user: { id: string; email?: string | null },
): Promise<Set<string>> {
  const email = (user.email || "").toLowerCase();
  const db = sb.schema(JUKEBOX_SCHEMA);
  const [uploads, grants, agreements] = await Promise.all([
    db.from("artists").select("id").eq("artist_upload_created_by", user.id),
    email
      ? db.from("artist_upload_grants").select("artist_id").eq("user_email", email)
      : Promise.resolve({ data: [] as { artist_id: string }[] }),
    db.from("artist_rights_agreements").select("artist_id").eq("user_id", user.id).eq("status", "approved"),
  ]);
  const out = new Set<string>();
  (uploads.data || []).forEach((r: { id: string }) => out.add(r.id));
  (grants.data || []).forEach((r: { artist_id: string }) => r.artist_id && out.add(r.artist_id));
  (agreements.data || []).forEach((r: { artist_id: string | null }) => r.artist_id && out.add(r.artist_id));
  return out;
}

export type StatsArtist = { id: string; name: string; slug: string };

/** Every artist whose stats this user can open, for the picker. */
export async function listStatsArtists(
  sb: ReturnType<typeof createSjServiceClient>,
  user: { id: string; email?: string | null },
): Promise<StatsArtist[]> {
  const email = (user.email || "").toLowerCase();
  const db = sb.schema(JUKEBOX_SCHEMA);
  const ids = await artistIdsAsArtist(sb, user);
  if (email) {
    const [added, access] = await Promise.all([
      db.from("artists").select("id, added_by").ilike("added_by", email),
      db.from("content_access").select("artist_id").eq("user_email", email),
    ]);
    // ilike treats _ in an address as a wildcard, so confirm the match here.
    (added.data || [])
      .filter((r: { added_by: string | null }) => (r.added_by || "").toLowerCase() === email)
      .forEach((r: { id: string }) => ids.add(r.id));
    (access.data || []).forEach((r: { artist_id: string }) => ids.add(r.artist_id));
  }
  const official = email === OFFICIAL_OWNER ? [...OFFICIAL_MANAGE_SLUGS] : [];
  if (!ids.size && !official.length) return [];
  const filters = [
    ids.size ? `id.in.(${[...ids].join(",")})` : "",
    official.length ? `slug.in.(${official.join(",")})` : "",
  ].filter(Boolean).join(",");
  const { data } = await db.from("artists").select("id, name, slug").or(filters).order("name");
  return ((data || []) as StatsArtist[]).filter((a) => a.slug);
}
