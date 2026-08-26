import { NextRequest, NextResponse } from "next/server";
import { fetchYouTubeVideoInfo, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import {
  addCatalogItems,
  addYouTubeItem,
  loadLibrary,
  logMyJukeboxPlay,
  ownerMyJukebox,
  removeLibraryItems,
} from "@/lib/my-jukebox";
import { SINGLES_ALBUM, importSingleTrack, readArtistAndTitle } from "@/lib/single-import";
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

        // A single lands in the catalogue as well as the personal library, so
        // it groups with everything else by that artist and turns up on
        // Explore Artists as a card. Private by default: a loose song somebody
        // found is their business until they say otherwise, and the card's own
        // control is how it goes public.
        const visibility = body.visibility === "public" ? "public" : "private";
        const read = readArtistAndTitle(info.title, info.channelTitle);
        const artistName = text(body.artistName, 160) ?? read.artistName;
        const trackName = text(body.trackName, 180) ?? read.trackName;
        // Spotify knows the length; YouTube contentDetails is the fallback.
        // Either one lets LRCLIB do an exact-duration match the way album
        // imports do.
        const durationMs =
          (typeof body.durationMs === "number" && body.durationMs > 0 ? Math.round(body.durationMs) : null)
          ?? info.durationMs
          ?? null;

        const result = await addYouTubeItem(ctx.sb, ctx.jukebox.id, {
          videoId: id,
          title: trackName,
          artistName,
          albumName: text(body.albumName) ?? SINGLES_ALBUM,
          thumbnail: info.thumbnail,
          views: info.views,
          durationMs,
          source: body.source === "spotify" ? "spotify" : "youtube",
          sourceUri: text(body.sourceUri, 2000),
          // No unlicensed lyrics scraper: the import records that it checked,
          // while catalog additions carry lyrics already licensed/stored here.
          lyrics: null,
          lyricsSource: null,
        });

        let artist: { id: string; name: string; slug: string } | null = null;
        let catalogTrackId: string | null = null;
        let lyricsFound = false;
        let lyricsSynced = false;
        try {
          const imported = await importSingleTrack(ctx.sb, {
            videoId: id,
            title: info.title,
            channelTitle: info.channelTitle,
            thumbnail: info.thumbnail,
            views: info.views,
            durationMs,
            artistName,
            trackName,
            visibility,
            userEmail: ctx.user.email,
            userName: text(body.userName, 120),
          });
          artist = { id: imported.artistId, name: imported.artistName, slug: imported.artistSlug };
          // The wizard's last step goes and finds the words for these, so it
          // needs the catalogue track id, not just the library row.
          catalogTrackId = imported.trackId;
          lyricsFound = imported.lyricsFound;
          lyricsSynced = imported.lyricsSynced;

          // Link the library row to the catalogue song and stamp any lyrics we
          // just found, so My Jukebox and Explore stay in step.
          if (catalogTrackId) {
            const patch: Record<string, unknown> = {
              catalog_track_id: catalogTrackId,
              duration_ms: durationMs,
            };
            if (lyricsFound) {
              const { data: lyr } = await ctx.sb.schema(JUKEBOX_SCHEMA).from("lyrics")
                .select("lyrics,lyrics_source").eq("track_id", catalogTrackId).maybeSingle();
              if (lyr?.lyrics) {
                patch.lyrics = lyr.lyrics;
                patch.lyrics_source = lyr.lyrics_source ?? "lrclib";
                patch.lyrics_checked_at = new Date().toISOString();
              }
            } else {
              patch.lyrics_checked_at = new Date().toISOString();
            }
            let q = ctx.sb.schema(JUKEBOX_SCHEMA).from("my_jukebox_items").update(patch);
            if (result.item?.id) q = q.eq("id", result.item.id);
            else q = q.eq("jukebox_id", ctx.jukebox.id).eq("youtube_video_id", id);
            await q;
          }
        } catch (err) {
          // The library row is the promise we made; the catalogue card is the
          // bonus. Failing the whole request over the card would lose the song.
          console.error("[my-jukebox:single-import]", err);
        }

        return NextResponse.json({
          ok: true,
          ...result,
          artist,
          catalogTrackId,
          lyricsFound,
          lyricsSynced,
          visibility,
          items: await loadLibrary(ctx.sb, ctx.jukebox.id),
        });
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
