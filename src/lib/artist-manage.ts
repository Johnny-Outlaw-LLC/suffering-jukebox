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
