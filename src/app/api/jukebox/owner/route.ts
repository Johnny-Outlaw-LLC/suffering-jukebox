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
  EMPTY_PLAYBACK,
  MAX_JUKEBOX_NAME,
  midpointSort,
  normalizePlayback,
  normalizeSettings,
  normalizeVanitySlug,
  sanitizeDisplayName,
  type HostQueueItem,
} from "@/lib/jukebox";
import {
  artistSlugExists,
  clearQueue,
  codeExists,
  expireStaleBroadcast,
  getOrCreateOwnerJukebox,
  getQueueItem,
  listGuestSongs,
  listListeners,
  loadPending,
  loadQueue,
  loadRecentlyPlayed,
  markPlayed,
  markPlaying,
  removeAllForGuest,
  removeQueueItem,
  setGuestBanned,
  setPlayback,
  setQueueItemSort,
  sjb,
  syncHostQueue,
  updateJukebox,
  type JukeboxRow,
  type ServiceClient,
} from "@/lib/jukebox-db";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { bad, publicJukebox } from "@/lib/jukebox-request";

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
  const jukebox = await expireStaleBroadcast(
    sb,
    await getOrCreateOwnerJukebox(sb, user.email, name),
  );
  return { sb, jukebox, email: user.email };
}

async function fullState(sb: ServiceClient, jukebox: JukeboxRow) {
  const [queue, listeners, recentlyPlayed] = await Promise.all([
    loadQueue(sb, jukebox.id),
    listListeners(sb, jukebox.id),
    loadRecentlyPlayed(sb, jukebox.id),
  ]);
  // Only the people in the room. Nobody else is on the panel, so pulling
  // their songs would be work nothing renders.
  const guestSongs = await listGuestSongs(sb, jukebox.id, listeners.map((l) => l.id));
  return {
    jukebox: { ...publicJukebox(jukebox), id: jukebox.id },
    nowPlaying: queue.find((q) => q.status === "playing") ?? null,
    queue: queue.filter((q) => q.status === "pending"),
    // Who is in the room right now, and what each of them put in the jukebox.
    // The panel expands a name into their songs without another request.
    listeners,
    guestSongs,
    recentlyPlayed,
    serverTime: new Date().toISOString(),
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
          ...(isLive
            ? { last_live_at: new Date().toISOString() }
            : // Off air clears the mirror too. A guest who leaves the page open
              // should see the room go quiet, not keep watching a video nobody
              // is playing any more.
              { playback: EMPTY_PLAYBACK }),
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

      // The whole point of act two: the room is a mirror of the host's own
      // player queue, not a second list beside it. The host pushes what it is
      // holding every few seconds; this makes the room agree, and hands back
      // the guest adds the host has not seen so it can play and announce them.
      case "sync": {
        const rawItems = Array.isArray(body.items) ? body.items.slice(0, 600) : [];
        const items: HostQueueItem[] = rawItems.map((raw: any, i: number) => ({
          index: Number.isFinite(Number(raw?.index)) ? Number(raw.index) : i,
          trackId: uuid(raw?.trackId ?? raw?.track_id),
          videoId: typeof raw?.videoId === "string" ? raw.videoId.slice(0, 40) : null,
          itemId: uuid(raw?.itemId ?? raw?.item_id),
          addedBy: typeof raw?.addedBy === "string" ? raw.addedBy.slice(0, 60) : null,
        }));
        const currentIndex = Number.isFinite(Number(body.currentIndex))
          ? Number(body.currentIndex)
          : -1;
        // Rows created after the host last heard from us cannot be songs it
        // deleted, so they are adopted rather than swept. No `since` at all is
        // a host that has just reloaded and knows about nothing yet: zero makes
        // every row newer than the snapshot, so the room's queue is adopted
        // back into the player instead of being wiped.
        const snapshotAtMs = Date.parse(String(body.since ?? "")) || 0;

        const result = await syncHostQueue(sb, jukebox.id, {
          items,
          currentIndex,
          snapshotAtMs,
          ownerName: jukebox.name,
          lastQueue: jukebox.last_queue,
        });

        const playback = await setPlayback(sb, jukebox.id, normalizePlayback(body.playback));

        // The listeners panel runs off this, so it keeps working with the
        // console closed - which is the normal case for a host watching the
        // room rather than the app.
        const listeners = await listListeners(sb, jukebox.id);
        const guestSongs = await listGuestSongs(sb, jukebox.id, listeners.map((l) => l.id));

        return NextResponse.json({
          ok: true,
          ...result,
          listeners,
          guestSongs,
          playback,
          isLive: jukebox.is_live,
          settings: jukebox.settings,
          serverTime: new Date().toISOString(),
        });
      }

      // The vanity address people actually type: sufferingjukebox.stream/outlaw.
      // Refused rather than silently renamed when it would shadow an artist
      // page, another room, or a page this site already owns.
      case "slug": {
        const raw = typeof body.slug === "string" ? body.slug.trim() : "";
        if (!raw) {
          jukebox = await updateJukebox(sb, jukebox.id, { public_slug: null });
          break;
        }
        const parsed = normalizeVanitySlug(raw);
        if (!parsed.ok) return bad(parsed.message);
        const slug = parsed.slug;
        if (slug !== (jukebox.public_slug ?? "").toLowerCase()) {
          if (await artistSlugExists(sb, slug)) {
            return bad(`sufferingjukebox.stream/${slug} is an artist page. Pick another.`);
          }
          if (await codeExists(sb, slug)) {
            return bad("That address is taken. Pick another.");
          }
        }
        try {
          jukebox = await updateJukebox(sb, jukebox.id, { public_slug: slug });
        } catch (err: any) {
          // 23505: somebody claimed it between the check and the write.
          if (err?.code === "23505") return bad("That address is taken. Pick another.");
          throw err;
        }
        break;
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
