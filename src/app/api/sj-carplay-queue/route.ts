import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/artist-rights";
import { getAuthUser, createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

/**
 * The CarPlay queue: songs picked on one device for another device to download.
 *
 * CarPlay can only play files that are already on the phone, and picking a
 * drive's worth of music on a phone is miserable. So the desktop queues, the
 * phone accepts. Nothing here moves audio - the queue is a list of track ids,
 * and the phone still fetches its own signed URL from /api/sj-audio when the
 * listener actually accepts.
 *
 * Only a track the caller has uploaded audio for can be queued: that is the
 * same set the native engine is allowed to download, so a row that survives
 * this check is always something the phone can act on.
 */

export const dynamic = "force-dynamic";

// One drive's worth, generously. Bounds both the request body and the reply.
const MAX_IDS = 200;

type QueueRow = { track_id: string; queued_at: string; accepted_at: string | null };

type QueueItem = {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  bytes: number;
  queuedAt: string;
  acceptedAt: string | null;
};

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function parseIds(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(raw.map((v) => String(v).trim()).filter(isUuid))].slice(0, MAX_IDS);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type ServiceClient = ReturnType<typeof createSjServiceClient>;

/** Track ids in `ids` the user has actually uploaded a file for. */
async function ownedTrackIds(sb: ServiceClient, userId: string, ids: string[]): Promise<Set<string>> {
  const owned = new Set<string>();
  for (const part of chunk(ids, 50)) {
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .select("track_id,storage_path")
      .eq("uploaded_by", userId)
      .in("track_id", part);
    if (error) throw error;
    (data || []).forEach((row) => {
      if (row.storage_path) owned.add(row.track_id);
    });
  }
  return owned;
}

/**
 * The queue with enough metadata to draw a list and label a download.
 *
 * Resolved here rather than on the phone: the accept screen is the first thing
 * the listener sees in the car park, and four rounds of PostgREST lookups over
 * a phone connection is exactly where it would stall.
 */
async function loadItems(sb: ServiceClient, userId: string): Promise<QueueItem[]> {
  const { data: queued, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("carplay_queue")
    .select("track_id,queued_at,accepted_at")
    .eq("user_id", userId)
    .order("queued_at", { ascending: true })
    .limit(MAX_IDS);
  if (error) throw error;

  const rows = (queued || []) as QueueRow[];
  const ids = rows.map((r) => r.track_id);
  if (!ids.length) return [];

  const audio = new Map<string, { bytes: number; duration: number }>();
  const tracks = new Map<string, { name: string; albumId: string | null; durationMs: number | null }>();
  const albums = new Map<string, { name: string; artistId: string | null; artUrl: string | null }>();
  const artists = new Map<string, string>();

  for (const part of chunk(ids, 50)) {
    const { data, error: audioError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("track_audio")
      .select("track_id,file_bytes,duration_seconds")
      .eq("uploaded_by", userId)
      .in("track_id", part);
    if (audioError) throw audioError;
    (data || []).forEach((row) => {
      audio.set(row.track_id, {
        bytes: Number(row.file_bytes) || 0,
        duration: Number(row.duration_seconds) || 0,
      });
    });

    const { data: trackRows, error: trackError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("tracks")
      .select("id,name,album_id,duration_ms")
      .in("id", part);
    if (trackError) throw trackError;
    (trackRows || []).forEach((row) => {
      tracks.set(row.id, { name: row.name, albumId: row.album_id, durationMs: row.duration_ms });
    });
  }

  const albumIds = [...new Set([...tracks.values()].map((t) => t.albumId).filter(Boolean))] as string[];
  for (const part of chunk(albumIds, 50)) {
    const { data, error: albumError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .select("id,name,artist_id,art_url")
      .in("id", part);
    if (albumError) throw albumError;
    (data || []).forEach((row) =>
      albums.set(row.id, { name: row.name, artistId: row.artist_id, artUrl: row.art_url }));
  }

  const artistIds = [...new Set([...albums.values()].map((a) => a.artistId).filter(Boolean))] as string[];
  for (const part of chunk(artistIds, 50)) {
    const { data, error: artistError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artists")
      .select("id,name")
      .in("id", part);
    if (artistError) throw artistError;
    (data || []).forEach((row) => artists.set(row.id, row.name));
  }

  // A track whose audio was deleted after it was queued cannot be downloaded,
  // so it is dropped from the reply rather than offered and then failing.
  return rows
    .filter((row) => audio.has(row.track_id))
    .map((row) => {
      const track = tracks.get(row.track_id);
      const album = track?.albumId ? albums.get(track.albumId) : null;
      const file = audio.get(row.track_id)!;
      return {
        trackId: row.track_id,
        title: track?.name || "Untitled",
        artist: (album?.artistId && artists.get(album.artistId)) || "Unknown artist",
        album: album?.name || "",
        // Without this the car shows a grey note: the accept screen is the only
        // place these downloads get their metadata, and artwork has to be on
        // disk before the drive, since CarPlay has no network to go fetch it.
        artworkUrl: album?.artUrl || null,
        durationSeconds: file.duration || (track?.durationMs ? track.durationMs / 1000 : 0),
        bytes: file.bytes,
        queuedAt: row.queued_at,
        acceptedAt: row.accepted_at,
      };
    })
    .sort((a, b) =>
      a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.title.localeCompare(b.title),
    );
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  try {
    const items = await loadItems(createSjServiceClient(), user.id);
    return noStore({
      ok: true,
      items,
      pending: items.filter((i) => !i.acceptedAt).length,
    });
  } catch (e) {
    console.error("[sj-carplay-queue] GET", (e as Error).message);
    return noStore({ ok: false, error: "Could not load the CarPlay queue." }, 500);
  }
}

/** Queue songs for the phone. Body: { track_ids: string[] }. */
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  const body = await readBody(req);
  const ids = parseIds(body.track_ids);
  if (!ids.length) return noStore({ ok: false, error: "No songs to queue." }, 400);

  try {
    const sb = createSjServiceClient();
    const owned = await ownedTrackIds(sb, user.id, ids);
    const queueable = ids.filter((id) => owned.has(id));
    if (queueable.length) {
      // Re-queuing an already-accepted song is a deliberate ask - the listener
      // removed the download, or wants it back - so acceptance is cleared.
      const { error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("carplay_queue")
        .upsert(
          queueable.map((track_id) => ({
            user_id: user.id,
            track_id,
            queued_at: new Date().toISOString(),
            accepted_at: null,
          })),
          { onConflict: "user_id,track_id" },
        );
      if (error) throw error;
    }
    return noStore({ ok: true, queued: queueable.length, skipped: ids.length - queueable.length });
  } catch (e) {
    console.error("[sj-carplay-queue] POST", (e as Error).message);
    return noStore({ ok: false, error: "Could not queue those songs." }, 500);
  }
}

/**
 * Mark songs as taken by a device. Body: { track_ids: string[], accepted?: boolean }.
 * `accepted: false` puts them back in the pending list.
 */
export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  const body = await readBody(req);
  const ids = parseIds(body.track_ids);
  if (!ids.length) return noStore({ ok: false, error: "No songs to update." }, 400);
  const acceptedAt = body.accepted === false ? null : new Date().toISOString();

  try {
    const sb = createSjServiceClient();
    for (const part of chunk(ids, 50)) {
      const { error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("carplay_queue")
        .update({ accepted_at: acceptedAt })
        .eq("user_id", user.id)
        .in("track_id", part);
      if (error) throw error;
    }
    return noStore({ ok: true, updated: ids.length });
  } catch (e) {
    console.error("[sj-carplay-queue] PATCH", (e as Error).message);
    return noStore({ ok: false, error: "Could not update the CarPlay queue." }, 500);
  }
}

/** Body: { track_ids: string[] } or { all: true }. Never touches a downloaded file. */
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) return noStore({ ok: false, error: "Sign in required." }, 401);
  const body = await readBody(req);
  const all = body.all === true || req.nextUrl.searchParams.get("all") === "1";
  const ids = parseIds(body.track_ids ?? req.nextUrl.searchParams.get("track_ids"));
  if (!all && !ids.length) return noStore({ ok: false, error: "No songs to remove." }, 400);

  try {
    const sb = createSjServiceClient();
    if (all) {
      const { error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("carplay_queue")
        .delete()
        .eq("user_id", user.id);
      if (error) throw error;
    } else {
      for (const part of chunk(ids, 50)) {
        const { error } = await sb
          .schema(JUKEBOX_SCHEMA)
          .from("carplay_queue")
          .delete()
          .eq("user_id", user.id)
          .in("track_id", part);
        if (error) throw error;
      }
    }
    return noStore({ ok: true });
  } catch (e) {
    console.error("[sj-carplay-queue] DELETE", (e as Error).message);
    return noStore({ ok: false, error: "Could not update the CarPlay queue." }, 500);
  }
}
