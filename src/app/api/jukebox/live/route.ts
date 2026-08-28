import { NextRequest, NextResponse } from "next/server";
import { listListeners, listLiveJukeboxes, loadLastSyncedPlaylist, loadQueue, sjb } from "@/lib/jukebox-db";
import { getAuthUser } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sb = sjb();
    const user = await getAuthUser(req).catch(() => null);
    const rooms = await listLiveJukeboxes(sb);
    const playlists = await Promise.all(rooms.map(async (room) => {
      const [tracks, queue, listeners] = await Promise.all([
        loadLastSyncedPlaylist(sb, room),
        loadQueue(sb, room.id),
        listListeners(sb, room.id),
      ]);
      return {
        id: `live:${room.code}`,
        code: room.code,
        slug: room.public_slug,
        name: room.name,
        isOwner: !!user?.email && user.email.toLowerCase() === room.owner_email.toLowerCase(),
        playback: room.playback,
        tracks,
        queue,
        listenerCount: listeners.length,
        queuedSongCount: queue.filter((item) => item.status === "pending").length,
      };
    }));
    return NextResponse.json({ ok: true, playlists });
  } catch (error) {
    console.error("[jukebox:live]", error);
    return NextResponse.json({ ok: false, error: "Could not load live rooms." }, { status: 500 });
  }
}
