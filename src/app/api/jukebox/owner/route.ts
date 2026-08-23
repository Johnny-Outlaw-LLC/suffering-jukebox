// /api/jukebox/owner — everything the host can do to their own room.
//
// GET  returns the owner's jukebox, creating it on first look.
// POST performs one action, named in the body.
//
// Ownership is proved by an access token every time. It is never taken from
// the body, and there is no "owner cookie" — a guest seat can never be
// escalated into the host's chair.
import { NextRequest, NextResponse } from "next/server";
import {
  MAX_JUKEBOX_NAME,
  midpointSort,
  normalizeSettings,
  sanitizeDisplayName,
} from "@/lib/jukebox";
import {
  clearQueue,
  getOrCreateOwnerJukebox,
  getQueueItem,
  insertQueueItem,
  listGuests,
  loadPending,
  loadQueue,
  loadRecentlyPlayed,
  markPlayed,
  markPlaying,
  removeAllForGuest,
  removeQueueItem,
  setGuestBanned,
  setQueueItemSort,
  sjb,
  updateJukebox,
  type JukeboxRow,
  type ServiceClient,
} from "@/lib/jukebox-db";
import { JUKEBOX_SCHEMA, getAuthUser } from "@/lib/sj-admin-auth";
import { bad, publicJukebox } from "@/lib/jukebox-request";
import { appendSort } from "@/lib/jukebox";

export const dynamic = "force-dynamic";

const uuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null;

async function requireOwnerJukebox(req: NextRequest) {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) {
    return { error: bad("Sign in to manage your jukebox.", 401) };
  }
  const sb = sjb();
  const name =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    null;
  const jukebox = await getOrCreateOwnerJukebox(sb, user.email, name);
  return { sb, jukebox, email: user.email };
}

async function fullState(sb: ServiceClient, jukebox: JukeboxRow) {
  const [queue, guests, recentlyPlayed] = await Promise.all([
    loadQueue(sb, jukebox.id),
    listGuests(sb, jukebox.id),
    loadRecentlyPlayed(sb, jukebox.id),
  ]);
  return {
    jukebox: { ...publicJukebox(jukebox), id: jukebox.id },
    nowPlaying: queue.find((q) => q.status === "playing") ?? null,
    queue: queue.filter((q) => q.status === "pending"),
    guests,
    recentlyPlayed,
  };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireOwnerJukebox(req);
    if ("error" in ctx) return ctx.error;
    return NextResponse.json({ ok: true, ...(await fullState(ctx.sb, ctx.jukebox)) });
  } catch (err) {
    console.error("[jukebox:owner:get]", err);
    return bad("Could not load your jukebox.", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ctx = await requireOwnerJukebox(req);
    if ("error" in ctx) return ctx.error;
    const { sb, email } = ctx;
    let { jukebox } = ctx;
    const by = `owner:${email}`;

    switch (body.action) {
      case "live": {
        const isLive = body.is_live !== false;
        jukebox = await updateJukebox(sb, jukebox.id, {
          is_live: isLive,
          ...(isLive ? { last_live_at: new Date().toISOString() } : {}),
        });
        break;
      }

      case "settings": {
        // Merged, not replaced, so a client sending a partial object cannot
        // silently reset settings it did not know about.
        const settings = normalizeSettings({ ...jukebox.settings, ...(body.settings ?? {}) });
        jukebox = await updateJukebox(sb, jukebox.id, { settings });
        break;
      }

      case "rename": {
        const name = sanitizeDisplayName(body.name)?.slice(0, MAX_JUKEBOX_NAME);
        if (!name) return bad("Give the jukebox a name.");
        jukebox = await updateJukebox(sb, jukebox.id, { name });
        break;
      }

      case "remove": {
        const itemId = uuid(body.item_id ?? body.itemId);
        if (!itemId) return bad("Missing queue item.");
        const item = await getQueueItem(sb, itemId, jukebox.id);
        if (!item) return bad("That song is no longer in the queue.", 404);
        await removeQueueItem(sb, itemId, by);
        break;
      }

      case "reorder": {
        // The client sends the neighbours the row was dropped between and the
        // server works out the value, so two hosts dragging at once cannot
        // corrupt the ordering of the whole queue.
        const itemId = uuid(body.item_id ?? body.itemId);
        if (!itemId) return bad("Missing queue item.");
        const item = await getQueueItem(sb, itemId, jukebox.id);
        if (!item || item.status !== "pending") return bad("That song cannot be moved.", 404);

        const pending = (await loadPending(sb, jukebox.id)).filter((p) => p.id !== itemId);
        const beforeId = uuid(body.before_id ?? body.beforeId);
        const afterId = uuid(body.after_id ?? body.afterId);
        const before = beforeId ? (pending.find((p) => p.id === beforeId)?.sort ?? null) : null;
        const after = afterId ? (pending.find((p) => p.id === afterId)?.sort ?? null) : null;
        if (before == null && after == null && pending.length) {
          return bad("Could not work out where to put that song.");
        }
        await setQueueItemSort(sb, itemId, midpointSort(before, after));
        break;
      }

      case "clear": {
        const removed = await clearQueue(sb, jukebox.id, by);
        return NextResponse.json({ ok: true, removed, ...(await fullState(sb, jukebox)) });
      }

      case "ban":
      case "unban": {
        const guestId = uuid(body.guest_id ?? body.guestId);
        if (!guestId) return bad("Missing guest.");
        const banned = body.action === "ban";
        await setGuestBanned(sb, guestId, banned);
        // Banning takes their waiting songs with them by default; the point of
        // a ban is usually the songs. Pass sweep:false to leave them in place.
        let swept = 0;
        if (banned && body.sweep !== false) {
          swept = await removeAllForGuest(sb, jukebox.id, guestId, by);
        }
        return NextResponse.json({ ok: true, swept, ...(await fullState(sb, jukebox)) });
      }

      case "playing": {
        const itemId = uuid(body.item_id ?? body.itemId);
        if (!itemId) return bad("Missing queue item.");
        await markPlaying(sb, jukebox.id, itemId);
        break;
      }

      case "played": {
        const itemId = uuid(body.item_id ?? body.itemId);
        if (!itemId) return bad("Missing queue item.");
        await markPlayed(sb, jukebox.id, itemId);
        break;
      }

      case "seed_playlist": {
        const playlistId = uuid(body.playlist_id ?? body.playlistId);
        if (!playlistId) return bad("Missing playlist.");
        const added = await seedFromPlaylist(sb, jukebox, playlistId, email);
        if (typeof added !== "number") return added;
        return NextResponse.json({ ok: true, added, ...(await fullState(sb, jukebox)) });
      }

      default:
        return bad("Unknown action.");
    }

    return NextResponse.json({ ok: true, ...(await fullState(sb, jukebox)) });
  } catch (err) {
    console.error("[jukebox:owner:post]", err);
    return bad("Could not update your jukebox.", 500);
  }
}

/**
 * Send a saved playlist to the jukebox. Owner adds bypass the guest fairness
 * rules, but duplicates already waiting are still skipped so sending the same
 * playlist twice does not double the queue.
 */
async function seedFromPlaylist(
  sb: ServiceClient,
  jukebox: JukeboxRow,
  playlistId: string,
  email: string,
): Promise<number | NextResponse> {
  const { data: playlist, error: plErr } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("playlists")
    .select("id,name,user_email,is_public")
    .eq("id", playlistId)
    .maybeSingle();
  if (plErr) throw plErr;
  if (!playlist) return bad("No such playlist.", 404);

  const mine = (playlist.user_email ?? "").toLowerCase() === email.toLowerCase();
  if (!mine && !playlist.is_public) return bad("That playlist is not yours.", 403);

  const { data: rows, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("playlist_tracks")
    .select("track_id,position")
    .eq("playlist_id", playlistId)
    .order("position", { ascending: true });
  if (error) throw error;

  // playlist_tracks.track_id is text rather than uuid, so anything that is not
  // a real track id is dropped instead of blowing up the insert.
  const trackIds = (rows ?? []).map((r: any) => uuid(r.track_id)).filter(Boolean) as string[];
  if (!trackIds.length) return 0;

  const pending = await loadPending(sb, jukebox.id);
  const already = new Set(pending.map((p) => p.trackId));
  let sort = appendSort(pending);
  let added = 0;

  for (const trackId of trackIds) {
    if (already.has(trackId)) continue;
    already.add(trackId);
    try {
      await insertQueueItem(sb, {
        jukeboxId: jukebox.id,
        trackId,
        videoId: null,
        guestId: null,
        addedByName: jukebox.name,
        addedByOwner: true,
        sort,
      });
      sort += 1024;
      added++;
    } catch (err) {
      // A track that has since been deleted should not abort the whole send.
      console.error("[jukebox:seed] skipped", trackId, err);
    }
  }
  return added;
}
