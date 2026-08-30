import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { bad, rateLimited } from "@/lib/jukebox-request";

export const dynamic = "force-dynamic";
const cleanEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL || "https://sufferingjukebox.stream").replace(/\/$/, "");

function emailHtml(playlistName: string) {
  const name = playlistName.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
  return `<!doctype html><html><body style="margin:0;background:#090909;color:#f5f1eb;font-family:Arial,sans-serif"><main style="max-width:560px;margin:0 auto;padding:36px 24px"><p style="margin:0 0 18px;color:#ff6b35;font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase">Suffering Jukebox</p><h1 style="margin:0 0 16px;font-size:28px;line-height:1.15">Johnny Outlaw has shared a playlist with you.</h1><p style="color:#c8c8c8;line-height:1.55">You now have access to <strong style="color:#fff">${name}</strong>.</p><p style="margin:28px 0"><a href="${siteUrl()}" style="display:inline-block;padding:13px 18px;border-radius:8px;background:#ff6b35;color:#17110f;font-weight:700;text-decoration:none">Log in to Suffering Jukebox to play</a></p><p style="color:#888;font-size:13px;line-height:1.5">Use the email address this invitation was sent to when you log in.</p></main></body></html>`;
}

async function sendShareEmail(recipient: string, playlistName: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { sent: false, reason: "Email notifications are not configured yet." };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: "Johnny Outlaw shared a playlist with you",
      html: emailHtml(playlistName),
    }),
  });
  if (!response.ok) {
    console.error("[playlist-share:email]", response.status, await response.text());
    return { sent: false, reason: "The invitation email could not be sent." };
  }
  return { sent: true };
}

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
      // `id` is required for cover/detail reorder (plWallMoveTrack patches by
      // playlist_tracks.id). Omitting it made every Explore Playlist arrow a
      // silent no-op while Now Playing still worked.
      const { data: tracks } = rows.length ? await sb.schema(JUKEBOX_SCHEMA).from("playlist_tracks").select("id,playlist_id,track_id,position,added_by_email,added_by_name").in("playlist_id", rows.map(x => x.id)).order("position") : { data: [] };
      return NextResponse.json({ ok:true, playlists: rows.map(row => ({ ...row, _tracks:(tracks || []).filter(track => track.playlist_id === row.id) })) });
    }
    return bad("Playlist link sharing is no longer available.", 404);
  } catch (error) { console.error("[playlist-share:read]", error); return bad("Could not open this shared playlist.", 500); }
}

async function owner(req: NextRequest, playlistId: string) {
  const user = await getAuthUser(req);
  if (!user?.email) return null;
  const sb = createSjServiceClient();
  const { data } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("id,name").eq("id", playlistId).eq("user_email", cleanEmail(user.email)).maybeSingle();
  return data ? { user, sb, data } : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const playlistId = String(body.playlistId || "");
    const action = String(body.action || "");
    const found = await owner(req, playlistId);
    if (!found) return bad("Only the playlist owner can change sharing.", 403);
    const { sb, user, data: playlist } = found;
    if (action === "settings") {
      const visibility = ["private", "shared", "public"].includes(body.visibility) ? body.visibility : "private";
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({ visibility, is_public: visibility === "public", share_token_hash: null, share_token_created_at: null }).eq("id", playlistId);
      if (error) throw error;
      return NextResponse.json({ ok: true, visibility });
    }
    if (action === "invite") {
      if (rateLimited(`playlist-share-invite:${user.id}`, 12, 60_000)) return bad("Please wait a moment before sending another invitation.", 429);
      const email = cleanEmail(body.email); if (!/^\S+@\S+\.\S+$/.test(email)) return bad("Enter a valid email address.");
      const { data: existing, error: existingError } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").select("recipient_email").eq("playlist_id", playlistId).eq("recipient_email", email).maybeSingle();
      if (existingError) throw existingError;
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").upsert({ playlist_id: playlistId, recipient_email: email });
      if (error) throw error;
      await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({ visibility: "shared", is_public: false }).eq("id", playlistId);
      const emailResult = existing ? { sent: false, reason: "That person already has access." } : await sendShareEmail(email, playlist.name || "a playlist");
      return NextResponse.json({ ok: true, email, emailSent: emailResult.sent, emailNotice: emailResult.reason || null });
    }
    if (action === "list-invites") {
      const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").select("recipient_email,created_at").eq("playlist_id", playlistId).order("created_at");
      if (error) throw error;
      return NextResponse.json({ ok: true, recipients: data || [] });
    }
    if (action === "remove-invite") {
      const { error } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").delete().eq("playlist_id", playlistId).eq("recipient_email", cleanEmail(body.email));
      if (error) throw error; return NextResponse.json({ ok: true });
    }
    return bad("Unknown share action.");
  } catch (error) { console.error("[playlist-share]", error); return bad("Could not update playlist sharing.", 500); }
}
