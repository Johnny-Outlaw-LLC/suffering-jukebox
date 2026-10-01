import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA, SJ_PROTECTED_ADMIN_EMAIL } from "@/lib/sj-admin-auth";
import { bad, rateLimited, tooMany } from "@/lib/jukebox-request";
import { cleanEmail } from "@/lib/playlist-grants";

export const dynamic = "force-dynamic";

/* Reporting and blocking for content other people make (App Store Guideline
   1.2). Public and shared playlists are the content: a report names one, and a
   block hides every playlist the blocked person owns from the blocker. The
   block is applied where playlists are served (/api/playlist-share), so it
   holds on every device the blocker signs in on. */

const REASONS = new Set(["offensive", "spam", "harassment", "copyright", "other"]);

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

/* The owner acts on every report within 24 hours, so every report is mailed
   to them as it arrives. Without Resend configured the row is still saved. */
async function notifyOwner(report: { reason: string; details: string; playlistName: string; playlistId: string; reportedEmail: string; reporterEmail: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return;
  const html = `<p><b>Content report</b> (${esc(report.reason)})</p>
<p>Playlist: ${esc(report.playlistName || "(untitled)")} <code>${esc(report.playlistId)}</code><br>
Owner: ${esc(report.reportedEmail || "unknown")}<br>
Reported by: ${esc(report.reporterEmail)}</p>
<p>${esc(report.details || "No details given.")}</p>
<p>Review it in jukebox.content_reports and remove the playlist or the account within 24 hours.</p>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [SJ_PROTECTED_ADMIN_EMAIL], subject: `Content report: ${report.playlistName || "playlist"}`, html }),
  }).catch(error => { console.error("[sj-ugc:notify]", error); return null; });
  if (response && !response.ok) console.error("[sj-ugc:notify]", response.status, await response.text());
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  const email = cleanEmail(user?.email);
  if (!email) return NextResponse.json({ ok: true, blocked: [] });
  const sb = createSjServiceClient();
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("user_blocks")
    .select("blocked_email,created_at").eq("blocker_email", email).order("created_at", { ascending: false });
  if (error) { console.error("[sj-ugc:list]", error.message); return bad("Could not load your blocked people.", 502); }
  const blockedEmails = (data || []).map(r => r.blocked_email);
  // Show people by the name they go by, never by email address.
  const { data: names } = blockedEmails.length
    ? await sb.schema(JUKEBOX_SCHEMA).from("app_users").select("email,public_name,user_name").in("email", blockedEmails)
    : { data: [] };
  const nameOf = new Map((names || []).map(n => [cleanEmail(n.email), n.public_name || n.user_name || ""]));
  return NextResponse.json({
    ok: true,
    blocked: (data || []).map(r => ({ id: r.blocked_email, name: nameOf.get(r.blocked_email) || "A listener", since: r.created_at })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  const email = cleanEmail(user?.email);
  if (!user || !email) return bad("Sign in to report or block.", 401);
  if (rateLimited(`sj-ugc:${user.id}`, 20, 60_000)) return tooMany();

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");
  const sb = createSjServiceClient();

  // Who is being reported or blocked comes from the playlist on the server,
  // never from the page, so nobody can block or report by guessing an email.
  async function playlistOwner(id: unknown) {
    const playlistId = String(id || "");
    if (!/^[0-9a-f-]{36}$/i.test(playlistId)) return null;
    const { data } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("id,name,user_email").eq("id", playlistId).maybeSingle();
    return data ? { id: data.id as string, name: (data.name as string) || "", owner: cleanEmail(data.user_email) } : null;
  }

  if (action === "report") {
    const reason = String(body?.reason || "");
    if (!REASONS.has(reason)) return bad("Choose why you are reporting this.");
    const playlist = await playlistOwner(body?.playlistId);
    if (!playlist) return bad("That playlist no longer exists.", 404);
    const details = String(body?.details || "").trim().slice(0, 2000);
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("content_reports").insert({
      reporter_email: email,
      reporter_user_id: user.id,
      playlist_id: playlist.id,
      playlist_name: playlist.name,
      reported_email: playlist.owner || null,
      reason,
      details: details || null,
    });
    if (error) { console.error("[sj-ugc:report]", error.message); return bad("Your report could not be sent. Please try again.", 502); }
    await notifyOwner({ reason, details, playlistName: playlist.name, playlistId: playlist.id, reportedEmail: playlist.owner, reporterEmail: email });
    return NextResponse.json({ ok: true });
  }

  if (action === "block") {
    const playlist = await playlistOwner(body?.playlistId);
    if (!playlist?.owner) return bad("That playlist no longer exists.", 404);
    if (playlist.owner === email) return bad("You cannot block yourself.");
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("user_blocks")
      .upsert({ blocker_email: email, blocked_email: playlist.owner }, { onConflict: "blocker_email,blocked_email" });
    if (error) { console.error("[sj-ugc:block]", error.message); return bad("Could not block this person. Please try again.", 502); }
    return NextResponse.json({ ok: true });
  }

  if (action === "unblock") {
    const blocked = cleanEmail(body?.id);
    if (!blocked) return bad("Choose who to unblock.");
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("user_blocks").delete().eq("blocker_email", email).eq("blocked_email", blocked);
    if (error) { console.error("[sj-ugc:unblock]", error.message); return bad("Could not unblock. Please try again.", 502); }
    return NextResponse.json({ ok: true });
  }

  return bad("Unknown action.");
}
