import { NextRequest, NextResponse } from "next/server";
import { fetchYouTubeVideoInfo } from "@/lib/sj-admin-auth";
import {
  addCatalogItems,
  addYouTubeItem,
  loadLibrary,
  logMyJukeboxPlay,
  ownerMyJukebox,
  removeLibraryItems,
} from "@/lib/my-jukebox";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";

const uuid = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
const videoId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
const text = (value: unknown, max = 180): string | null =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null;

async function owner(req: NextRequest) {
  const ctx = await ownerMyJukebox(req);
  return ctx ?? { error: bad("Sign in to manage My Jukebox.", 401) };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await owner(req);
    if ("error" in ctx) return ctx.error;
    const items = await loadLibrary(ctx.sb, ctx.jukebox.id);
    return NextResponse.json({
      ok: true,
      jukebox: {
        name: ctx.jukebox.name,
        code: ctx.jukebox.code,
        isLive: ctx.jukebox.is_live,
      },
      items,
    });
  } catch (error) {
    console.error("[my-jukebox:get]", error);
    return bad("Could not load My Jukebox.", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`my-jukebox:${clientIp(req)}`, 80)) return tooMany();
    const ctx = await owner(req);
    if ("error" in ctx) return ctx.error;
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case "add_catalog": {
        const scope = body.scope;
        const id = uuid(body.id);
        if ((scope !== "track" && scope !== "album" && scope !== "artist") || !id) {
          return bad("Choose a song, album, or artist to add.");
        }
        const result = await addCatalogItems(ctx.sb, ctx.jukebox.id, scope, id);
        return NextResponse.json({ ok: true, ...result, items: await loadLibrary(ctx.sb, ctx.jukebox.id) });
      }

      case "add_youtube": {
        const id = videoId(body.videoId);
        if (!id) return bad("That YouTube video does not look right.");
        const info = (await fetchYouTubeVideoInfo([id]))[id];
        if (!info?.playable) return bad("That YouTube video cannot play in the Jukebox.", 409);
        const result = await addYouTubeItem(ctx.sb, ctx.jukebox.id, {
          videoId: id,
          title: info.title,
          artistName: text(body.artistName),
          albumName: text(body.albumName),
          thumbnail: info.thumbnail,
          views: info.views,
          source: body.source === "spotify" ? "spotify" : "youtube",
          sourceUri: text(body.sourceUri, 2000),
          // No unlicensed lyrics scraper: the import records that it checked,
          // while catalog additions carry lyrics already licensed/stored here.
          lyrics: null,
          lyricsSource: null,
        });
        return NextResponse.json({ ok: true, ...result, items: await loadLibrary(ctx.sb, ctx.jukebox.id) });
      }

      case "remove": {
        const itemId = uuid(body.itemId);
        if (!itemId) return bad("Missing song.");
        const removed = await removeLibraryItems(ctx.sb, ctx.jukebox.id, { itemId });
        return NextResponse.json({ ok: true, removed, items: await loadLibrary(ctx.sb, ctx.jukebox.id) });
      }

      case "remove_artist": {
        const artistName = text(body.artistName, 160);
        if (!artistName) return bad("Missing artist.");
        const removed = await removeLibraryItems(ctx.sb, ctx.jukebox.id, { artistName });
        return NextResponse.json({ ok: true, removed, items: await loadLibrary(ctx.sb, ctx.jukebox.id) });
      }

      case "remove_album": {
        const albumName = text(body.albumName, 160);
        if (!albumName) return bad("Missing album.");
        const removed = await removeLibraryItems(ctx.sb, ctx.jukebox.id, { albumName });
        return NextResponse.json({ ok: true, removed, items: await loadLibrary(ctx.sb, ctx.jukebox.id) });
      }

      case "play": {
        const itemId = uuid(body.itemId);
        if (!itemId) return bad("Missing song.");
        await logMyJukeboxPlay(ctx.sb, ctx.jukebox.id, itemId, ctx.user.id);
        return NextResponse.json({ ok: true });
      }

      default:
        return bad("Unknown My Jukebox action.");
    }
  } catch (error) {
    console.error("[my-jukebox:post]", error);
    return bad("Could not update My Jukebox.", 500);
  }
}
