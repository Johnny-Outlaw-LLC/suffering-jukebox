import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { bad } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanEmail = (value: unknown) => String(value || "").trim().toLowerCase();

export async function GET(req: NextRequest) {
  try {
    const token = new URL(req.url).searchParams.get("token") || "";
    if (!token) {
      const user = await getAuthUser(req); const sb = createSjServiceClient(); const email = cleanEmail(user?.email);
      // `is_public` is the established production contract.  The sharing
      // migration adds `visibility`, but database migrations are deployed
      // separately from this Next app; keep public Explore working before and
      // after that migration has run.
      const { data: publicRows } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").eq("is_public", true).order("created_at", { ascending:false });
      const { data: mine } = email ? await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").eq("user_email", email).order("created_at", { ascending:false }) : { data: [] };
      const { data: grants } = email ? await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").select("playlist_id").eq("recipient_email", email) : { data: [] };
      const ids = [...new Set((grants || []).map(x => x.playlist_id))];
      const { data: shared } = ids.length ? await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").in("id", ids) : { data: [] };
      const rows = [...(publicRows || []), ...(mine || []), ...(shared || [])].filter((row, i, all) => all.findIndex(x => x.id === row.id) === i);
      const { data: tracks } = rows.length ? await sb.schema(JUKEBOX_SCHEMA).from("playlist_tracks").select("playlist_id,track_id,position").in("playlist_id", rows.map(x => x.id)).order("position") : { data: [] };
      return NextResponse.json({ ok:true, playlists: rows.map(row => ({ ...row, _tracks:(tracks || []).filter(track => track.playlist_id === row.id) })) });
    }
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return bad("That share link is invalid.", 404);
    const sb = createSjServiceClient();
    const { data: playlist, error } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("id,name,default_play_mode").eq("share_token_hash", digest(token)).eq("visibility", "link").maybeSingle();
    if (error) throw error; if (!playlist) return bad("That share link has expired or was revoked.", 404);
    const { data: tracks, error: trackError } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_tracks").select("track_id,position").eq("playlist_id", playlist.id).order("position");
    if (trackError) throw trackError;
    return NextResponse.json({ ok: true, playlist, tracks: tracks || [] });
  } catch (error) { console.error("[playlist-share:read]", error); return bad("Could not open this shared playlist.", 500); }
}

async function owner(req: NextRequest, playlistId: string) {
  const user = await getAuthUser(req);
  if (!user?.email) return null;
  const sb = createSjServiceClient();
  const { data } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("id").eq("id", playlistId).eq("user_email", cleanEmail(user.email)).maybeSingle();
  return data ? { user, sb } : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const playlistId = String(body.playlistId || "");
    const action = String(body.action || "");
    const found = await owner(req, playlistId);
    if (!found) return bad("Only the playlist owner can change sharing.", 403);
    const { sb } = found;
    if (action === "settings") {
      const visibility = ["private", "shared", "link", "public"].includes(body.visibility) ? body.visibility : "private";
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({ visibility, is_public: visibility === "public" }).eq("id", playlistId);
      if (error) throw error;
      return NextResponse.json({ ok: true, visibility });
    }
    if (action === "invite") {
      const email = cleanEmail(body.email); if (!/^\S+@\S+\.\S+$/.test(email)) return bad("Enter a valid email address.");
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").upsert({ playlist_id: playlistId, recipient_email: email });
      if (error) throw error;
      await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({ visibility: "shared", is_public: false }).eq("id", playlistId);
      return NextResponse.json({ ok: true, email });
    }
    if (action === "remove-invite") {
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").delete().eq("playlist_id", playlistId).eq("recipient_email", cleanEmail(body.email));
      if (error) throw error; return NextResponse.json({ ok: true });
    }
    if (action === "new-link") {
      const token = randomBytes(32).toString("base64url");
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({ visibility: "link", is_public: false, share_token_hash: digest(token), share_token_created_at: new Date().toISOString() }).eq("id", playlistId);
      if (error) throw error; return NextResponse.json({ ok: true, token });
    }
    if (action === "revoke-link") {
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({ share_token_hash: null, share_token_created_at: null, visibility: "private", is_public: false }).eq("id", playlistId);
      if (error) throw error; return NextResponse.json({ ok: true });
    }
    return bad("Unknown share action.");
  } catch (error) { console.error("[playlist-share]", error); return bad("Could not update playlist sharing.", 500); }
}
