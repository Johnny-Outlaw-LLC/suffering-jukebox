import { NextRequest, NextResponse } from "next/server";
import {
  createSjServiceClient,
  getAuthUser,
  isSjAdmin,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";
import { planAlbumMerge, type MergeTrack } from "@/lib/album-merge";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFICIAL_MANAGE_SLUGS = new Set(["silver-jews", "purple-mountains"]);
const OFFICIAL_OWNER = "johnnyoutlawllc@gmail.com";

const TRACK_CHILD_TABLES = [
  "metrics",
  "lyrics",
  "lyrics_edits",
  "playlist_tracks",
  "yt_daily_snapshots",
  "track_play_counts",
  "play_events",
  "rating_events",
  "feedback",
  "links",
  "track_videos",
] as const;

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

async function canManageArtist(
  sb: ReturnType<typeof createSjServiceClient>,
  email: string,
  artistId: string,
): Promise<boolean> {
  const e = email.toLowerCase();
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
  const { data: access } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("content_access")
    .select("artist_id")
    .eq("artist_id", artistId)
    .eq("user_email", e)
    .maybeSingle();
  return !!access;
}

async function deleteTrackRows(
  sb: ReturnType<typeof createSjServiceClient>,
  trackId: string,
) {
  for (const tbl of TRACK_CHILD_TABLES) {
    await sb.schema(JUKEBOX_SCHEMA).from(tbl).delete().eq("track_id", trackId);
  }
  const { error } = await sb.schema(JUKEBOX_SCHEMA).from("tracks").delete().eq("id", trackId);
  if (error) throw error;
}

async function deleteAlbumCascade(
  sb: ReturnType<typeof createSjServiceClient>,
  albumId: string,
) {
  const { data: tracks } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id")
    .eq("album_id", albumId);
  for (const t of tracks || []) {
    await deleteTrackRows(sb, t.id);
  }
  for (const tbl of ["metrics", "feedback", "links"] as const) {
    await sb.schema(JUKEBOX_SCHEMA).from(tbl).delete().eq("album_id", albumId);
  }
  const { error } = await sb.schema(JUKEBOX_SCHEMA).from("albums").delete().eq("id", albumId);
  if (error) throw error;
}

/**
 * Merge drop_album into keep_album. Same artist required. Matching songs keep
 * the older track id (history); extras move onto keep; drop is then removed.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) return bad("Sign in required.", 401);

  const body = await req.json().catch(() => ({}));
  const keepId = typeof body.keep_album_id === "string" ? body.keep_album_id.trim() : "";
  const dropId = typeof body.drop_album_id === "string" ? body.drop_album_id.trim() : "";
  if (!UUID.test(keepId) || !UUID.test(dropId)) return bad("keep_album_id and drop_album_id required.");
  if (keepId === dropId) return bad("Pick two different albums.");

  const sb = createSjServiceClient();
  const { data: albums, error: albumsError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id, name, artist_id, yt_playlist_id, release_date")
    .in("id", [keepId, dropId]);
  if (albumsError) throw albumsError;
  const keep = (albums || []).find((a) => a.id === keepId);
  const drop = (albums || []).find((a) => a.id === dropId);
  if (!keep || !drop) return bad("Album not found.", 404);
  if (keep.artist_id !== drop.artist_id) return bad("Albums must belong to the same artist.");
  if (!(await canManageArtist(sb, user.email, keep.artist_id))) {
    return bad("You can only merge albums on artists you manage.", 403);
  }

  const { data: tracks, error: tracksError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id, album_id, name, track_number, created_at")
    .in("album_id", [keepId, dropId]);
  if (tracksError) throw tracksError;

  const keepTracks = ((tracks || []).filter((t) => t.album_id === keepId) as MergeTrack[]);
  const dropTracks = ((tracks || []).filter((t) => t.album_id === dropId) as MergeTrack[]);
  const plans = planAlbumMerge(keepTracks, dropTracks);

  let moved = 0;
  let removedDupes = 0;
  for (const plan of plans) {
    if (plan.kind === "delete_drop") {
      await deleteTrackRows(sb, plan.dropId);
      removedDupes++;
    } else if (plan.kind === "move_drop_delete_keep") {
      const { error: moveError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .update({ album_id: keepId, track_number: plan.trackNumber })
        .eq("id", plan.dropId);
      if (moveError) throw moveError;
      await deleteTrackRows(sb, plan.keepId);
      removedDupes++;
      moved++;
    } else {
      const { error: moveError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("tracks")
        .update({ album_id: keepId, track_number: plan.trackNumber })
        .eq("id", plan.dropId);
      if (moveError) throw moveError;
      moved++;
    }
  }

  if (!keep.yt_playlist_id && drop.yt_playlist_id) {
    await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .update({ yt_playlist_id: drop.yt_playlist_id })
      .eq("id", keepId);
  }

  await deleteAlbumCascade(sb, dropId);

  return NextResponse.json({
    ok: true,
    keep_album_id: keepId,
    drop_album_id: dropId,
    moved,
    removed_dupes: removedDupes,
    keep_name: keep.name,
    drop_name: drop.name,
  });
}
