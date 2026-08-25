import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { spotifyCookieOptions, SPOTIFY_SESSION_COOKIE, SPOTIFY_STATE_COOKIE } from "@/lib/spotify";

export const dynamic = "force-dynamic";

// The connection lives entirely in a sealed cookie, so disconnecting is
// deleting it. There is nothing of Spotify's left on our side afterwards: no
// token, no user id, no saved list. Songs already imported stay, because those
// are the listener's own library now, not Spotify's.
export async function POST(req: NextRequest) {
  if (rateLimited(`spotify-disconnect:${clientIp(req)}`, 20)) return tooMany();
  const user = await getAuthUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "Sign in to manage your Spotify connection." }, { status: 401 });
  const response = NextResponse.json({ ok: true, connected: false });
  response.cookies.set(SPOTIFY_SESSION_COOKIE, "", spotifyCookieOptions(req, 0));
  response.cookies.set(SPOTIFY_STATE_COOKIE, "", spotifyCookieOptions(req, 0));
  return response;
}
