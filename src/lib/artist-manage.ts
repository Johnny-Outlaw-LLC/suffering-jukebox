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
 * Artist metrics are private. Admins may see all artists; other accounts need
 * a direct artist upload, an explicit upload grant, or an approved artist
 * agreement. Community imports and catalog editing access confer no stats access.
 */
export async function canViewArtistStats(
  sb: ReturnType<typeof createSjServiceClient>,
  user: { id: string; email?: string | null },
  artistId: string,
): Promise<boolean> {
  const email = (user.email || "").toLowerCase();
  if (email && (await isSjAdmin(email))) return true;
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
  if (email && (await isSjAdmin(email))) {
    const out: StatsArtist[] = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await db.from("artists").select("id, name, slug").order("name").range(start, start + 999);
      if (error) throw error;
      const rows = (data || []) as StatsArtist[];
      out.push(...rows.filter(a => a.slug));
      if (rows.length < 1000) return out;
    }
  }
  const ids = await artistIdsAsArtist(sb, user);
  if (!ids.size) return [];
  const { data, error } = await db.from("artists").select("id, name, slug").in("id", [...ids]).order("name");
  if (error) throw error;
  return ((data || []) as StatsArtist[]).filter((a) => a.slug);
}
