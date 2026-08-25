import { NextRequest, NextResponse } from "next/server";
import {
  createSjServiceClient,
  getAuthUser,
  isSjAdmin,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Album = {
  id: string;
  name: string | null;
  created_at: string;
};

type Track = {
  id: string;
  album_id: string;
  name: string | null;
  track_number: number | null;
  created_at: string;
};

function key(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isSingleAlbum(name: string | null | undefined) {
  return /^singles?$/.test(key(name));
}

/**
 * After a full-artist import, reuse an older single-track row if that exact
 * song was just imported into one of the artist's albums. Keeping the old row
 * keeps its play events, ratings, reactions, and saved-library references
 * attached to the song rather than replacing its history with a new UUID.
 */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const artistId = typeof body.artist_id === "string" ? body.artist_id.trim() : "";
  const importedAlbumNames = Array.isArray(body.album_names)
    ? body.album_names.filter((name: unknown): name is string => typeof name === "string").map(key).filter(Boolean)
    : [];
  const importedAfter = typeof body.imported_after === "string" ? new Date(body.imported_after) : null;
  if (!UUID.test(artistId) || !importedAlbumNames.length || !importedAfter || Number.isNaN(importedAfter.getTime())) {
    return NextResponse.json({ ok: false, error: "Artist and imported albums are required." }, { status: 400 });
  }

  const sb = createSjServiceClient();
  const { data: artist, error: artistError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id, added_by")
    .eq("id", artistId)
    .maybeSingle();
  if (artistError || !artist) {
    return NextResponse.json({ ok: false, error: "Artist not found." }, { status: 404 });
  }
  const canManage = (await isSjAdmin(user.email)) ||
    String(artist.added_by || "").toLowerCase() === user.email.toLowerCase();
  if (!canManage) {
    return NextResponse.json({ ok: false, error: "You can only consolidate music you imported." }, { status: 403 });
  }

  const { data: albums, error: albumsError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id, name, created_at")
    .eq("artist_id", artistId);
  if (albumsError) throw albumsError;

  const albumRows = (albums || []) as Album[];
  const singleAlbums = albumRows.filter((album) => isSingleAlbum(album.name));
  const importedNames = new Set(importedAlbumNames);
  const targetAlbums = albumRows.filter((album) =>
    !isSingleAlbum(album.name) && importedNames.has(key(album.name)));
  if (!singleAlbums.length || !targetAlbums.length) {
    return NextResponse.json({ ok: true, moved: [], skipped: 0 });
  }

  const allAlbumIds = [...singleAlbums, ...targetAlbums].map((album) => album.id);
  const { data: tracks, error: tracksError } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id, album_id, name, track_number, created_at")
    .in("album_id", allAlbumIds);
  if (tracksError) throw tracksError;

  const singleIds = new Set(singleAlbums.map((album) => album.id));
  const targetIds = new Set(targetAlbums.map((album) => album.id));
  const sourceByName = new Map<string, Track[]>();
  const targetByName = new Map<string, Track[]>();
  for (const track of (tracks || []) as Track[]) {
    const name = key(track.name);
    if (!name) continue;
    const into = singleIds.has(track.album_id)
      ? sourceByName
      : targetIds.has(track.album_id) && new Date(track.created_at).getTime() >= importedAfter.getTime()
        ? targetByName
        : null;
    if (!into) continue;
    const rows = into.get(name) || [];
    rows.push(track);
    into.set(name, rows);
  }

  const moved: Array<{ name: string; album_id: string }> = [];
  let skipped = 0;
  for (const [name, sources] of sourceByName) {
    const targets = targetByName.get(name) || [];
    if (sources.length !== 1 || targets.length !== 1) {
      skipped += sources.length;
      continue;
    }
    const source = sources[0];
    const target = targets[0];
    // The older single is the already-known song. A later single is a distinct
    // user addition and must not be folded into an album retroactively.
    if (new Date(source.created_at).getTime() >= importedAfter.getTime()) {
      skipped++;
      continue;
    }

    const { error: moveError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("tracks")
      .update({ album_id: target.album_id, track_number: target.track_number })
      .eq("id", source.id);
    if (moveError) throw moveError;

    // The imported row is new; the moved row is the durable identity that owns
    // historical play events. Deleting only this duplicate leaves that history
    // intact and lets normal cascade rules clean up its fresh import artifacts.
    const { error: deleteError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("tracks")
      .delete()
      .eq("id", target.id);
    if (deleteError) throw deleteError;
    moved.push({ name: source.name || name, album_id: target.album_id });
  }

  return NextResponse.json({ ok: true, moved, skipped });
}
