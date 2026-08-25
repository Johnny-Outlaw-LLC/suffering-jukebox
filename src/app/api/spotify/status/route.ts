import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { canReadPlaylists, spotifySessionFor } from "@/lib/spotify";

export const dynamic = "force-dynamic";

// Cookie-only, deliberately: My Jukebox opens far more often than anybody
// imports music, and asking Spotify every time would spend a network round
// trip to draw one button. It answers exactly one question - do we hold a
// connection for this account, and does it cover playlists.
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in to connect Spotify." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: true, connected: false, spotifyUserId: null, canReadPlaylists: false });
    return NextResponse.json({ ok: true, connected: true, spotifyUserId: found.session.spotifyUserId, canReadPlaylists: canReadPlaylists(found.session) });
  } catch {
    // Spotify not configured at all, or an unreadable cookie. Either way the
    // honest answer for the panel is "not connected".
    return NextResponse.json({ ok: true, connected: false, spotifyUserId: null, canReadPlaylists: false });
  }
}
