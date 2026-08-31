import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { bad, rateLimited } from "@/lib/jukebox-request";
import {
  PUBLIC_PRINCIPAL,
  cleanEmail,
  effectiveCaps,
  normalizeGrantFlags,
  presetFromPublicGrant,
  publicPresetGrant,
  shapeGrantRow,
  visibilityFromGrants,
  type PlaylistGrant,
} from "@/lib/playlist-grants";

export const dynamic = "force-dynamic";

const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL || "https://sufferingjukebox.stream").replace(/\/$/, "");

function emailHtml(playlistName: string, fromName: string) {
  const name = playlistName.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
  const who = (fromName || "Someone").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
  return `<!doctype html><html><body style="margin:0;background:#090909;color:#f5f1eb;font-family:Arial,sans-serif"><main style="max-width:560px;margin:0 auto;padding:36px 24px"><p style="margin:0 0 18px;color:#ff6b35;font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase">Suffering Jukebox</p><h1 style="margin:0 0 16px;font-size:28px;line-height:1.15">${who} has shared a playlist with you.</h1><p style="color:#c8c8c8;line-height:1.55">You now have access to <strong style="color:#fff">${name}</strong>.</p><p style="margin:28px 0"><a href="${siteUrl()}" style="display:inline-block;padding:13px 18px;border-radius:8px;background:#ff6b35;color:#17110f;font-weight:700;text-decoration:none">Log in to Suffering Jukebox to play</a></p><p style="color:#888;font-size:13px;line-height:1.5">Use the email address this invitation was sent to when you log in.</p></main></body></html>`;
}

async function sendShareEmail(recipient: string, playlistName: string, fromName: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { sent: false, reason: "Email notifications are not configured yet." };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: `${fromName || "Someone"} shared a playlist with you`,
      html: emailHtml(playlistName, fromName),
    }),
  });
  if (!response.ok) {
    console.error("[playlist-share:email]", response.status, await response.text());
    return { sent: false, reason: "The invitation email could not be sent." };
  }
  return { sent: true };
}

async function loadGrants(sb: ReturnType<typeof createSjServiceClient>, playlistIds: string[]) {
  if (!playlistIds.length) return [] as Array<{
    playlist_id: string;
    principal: string;
    can_view: boolean;
    can_add: boolean;
    can_reorder: boolean;
  }>;
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_grants")
    .select("playlist_id,principal,can_view,can_add,can_reorder")
    .in("playlist_id", playlistIds);
  if (error) throw error;
  return data || [];
}

function attachMeta(
  row: Record<string, unknown>,
  grants: PlaylistGrant[],
  viewerEmail: string,
  tracks: unknown[]
) {
  const ownerEmail = cleanEmail(row.user_email);
  const caps = effectiveCaps({
    ownerEmail,
    viewerEmail,
    grants,
    legacyPublic: !!row.is_public,
  });
  const pub = grants.find(g => g.principal === PUBLIC_PRINCIPAL) || null;
  const named = grants.filter(g => g.principal !== PUBLIC_PRINCIPAL);
  const sharedWithMe = !!viewerEmail && ownerEmail !== viewerEmail && named.some(g => g.principal === viewerEmail && g.canView);
  return {
    ...row,
    _tracks: tracks,
    _grants: grants,
    _caps: caps,
    _sharedWithMe: sharedWithMe,
    _publicPreset: pub ? presetFromPublicGrant(pub) : null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const token = new URL(req.url).searchParams.get("token") || "";
    if (!token) {
      const user = await getAuthUser(req);
      const sb = createSjServiceClient();
      const email = cleanEmail(user?.email);

      const { data: publicRows } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").eq("is_public", true).order("created_at", { ascending: false });
      const { data: mine } = email
        ? await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").eq("user_email", email).order("created_at", { ascending: false })
        : { data: [] };

      // Named grants (not Public) — Shared with me.
      const { data: grantRows } = email
        ? await sb.schema(JUKEBOX_SCHEMA).from("playlist_grants").select("playlist_id").eq("principal", email).eq("can_view", true)
        : { data: [] };
      const grantIds = [...new Set((grantRows || []).map(x => x.playlist_id))];
      const { data: shared } = grantIds.length
        ? await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").in("id", grantIds)
        : { data: [] };

      // Legacy playlist_access fallback if grants table was empty for an invite.
      const { data: accessRows } = email
        ? await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").select("playlist_id").eq("recipient_email", email)
        : { data: [] };
      const accessIds = [...new Set((accessRows || []).map(x => x.playlist_id))];
      const missingAccess = accessIds.filter(id => !grantIds.includes(id));
      const { data: accessShared } = missingAccess.length
        ? await sb.schema(JUKEBOX_SCHEMA).from("playlists").select("*").in("id", missingAccess)
        : { data: [] };

      const rows = [...(publicRows || []), ...(mine || []), ...(shared || []), ...(accessShared || [])]
        .filter((row, i, all) => all.findIndex(x => x.id === row.id) === i);

      const allGrants = await loadGrants(sb, rows.map(x => x.id));
      const grantsByPl = new Map<string, PlaylistGrant[]>();
      for (const g of allGrants) {
        const list = grantsByPl.get(g.playlist_id) || [];
        list.push(shapeGrantRow(g));
        grantsByPl.set(g.playlist_id, list);
      }

      const { data: tracks } = rows.length
        ? await sb.schema(JUKEBOX_SCHEMA).from("playlist_tracks")
          .select("id,playlist_id,track_id,position,added_by_email,added_by_name")
          .in("playlist_id", rows.map(x => x.id))
          .order("position")
        : { data: [] };

      return NextResponse.json({
        ok: true,
        playlists: rows.map(row => attachMeta(
          row,
          grantsByPl.get(row.id) || [],
          email,
          (tracks || []).filter(track => track.playlist_id === row.id)
        )),
      });
    }
    return bad("Playlist link sharing is no longer available.", 404);
  } catch (error) {
    console.error("[playlist-share:read]", error);
    return bad("Could not open this shared playlist.", 500);
  }
}

async function owner(req: NextRequest, playlistId: string) {
  const user = await getAuthUser(req);
  if (!user?.email) return null;
  const sb = createSjServiceClient();
  const { data } = await sb.schema(JUKEBOX_SCHEMA).from("playlists")
    .select("id,name,user_email,user_name,is_public,visibility")
    .eq("id", playlistId)
    .eq("user_email", cleanEmail(user.email))
    .maybeSingle();
  return data ? { user, sb, data } : null;
}

async function replaceGrants(
  sb: ReturnType<typeof createSjServiceClient>,
  playlistId: string,
  grants: PlaylistGrant[],
  ownerEmail: string
) {
  const owner = cleanEmail(ownerEmail);
  const cleaned = grants
    .map(shapeGrantRow)
    .filter(g => g.principal !== owner && g.canView)
    .filter((g, i, all) => all.findIndex(x => x.principal === g.principal) === i);

  const { error: delErr } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_grants").delete().eq("playlist_id", playlistId);
  if (delErr) throw delErr;

  if (cleaned.length) {
    const { error: insErr } = await sb.schema(JUKEBOX_SCHEMA).from("playlist_grants").insert(
      cleaned.map(g => ({
        playlist_id: playlistId,
        principal: g.principal,
        can_view: g.canView,
        can_add: g.canAdd,
        can_reorder: g.canReorder,
      }))
    );
    if (insErr) throw insErr;
  }

  // Keep playlist_access in step for anything still reading the old table.
  const named = cleaned.filter(g => g.principal !== PUBLIC_PRINCIPAL).map(g => g.principal);
  await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").delete().eq("playlist_id", playlistId);
  if (named.length) {
    await sb.schema(JUKEBOX_SCHEMA).from("playlist_access").insert(
      named.map(email => ({ playlist_id: playlistId, recipient_email: email }))
    );
  }

  const visibility = visibilityFromGrants(cleaned);
  const { error: upErr } = await sb.schema(JUKEBOX_SCHEMA).from("playlists").update({
    visibility,
    is_public: visibility === "public",
    share_token_hash: null,
    share_token_created_at: null,
  }).eq("id", playlistId);
  if (upErr) throw upErr;

  return { grants: cleaned, visibility };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const playlistId = String(body.playlistId || "");
    const action = String(body.action || "");

    // Caps for the current viewer — any signed-in user who can see the list.
    if (action === "my-caps") {
      const user = await getAuthUser(req);
      const sb = createSjServiceClient();
      const { data: pl } = await sb.schema(JUKEBOX_SCHEMA).from("playlists")
        .select("id,user_email,is_public")
        .eq("id", playlistId)
        .maybeSingle();
      if (!pl) return bad("Playlist not found.", 404);
      const grantRows = await loadGrants(sb, [playlistId]);
      const grants = grantRows.map(shapeGrantRow);
      const caps = effectiveCaps({
        ownerEmail: String(pl.user_email || ""),
        viewerEmail: user?.email,
        grants,
        legacyPublic: !!pl.is_public,
      });
      return NextResponse.json({
        ok: true,
        caps,
        grants,
        publicPreset: presetFromPublicGrant(grants.find(g => g.principal === PUBLIC_PRINCIPAL)),
      });
    }

    const found = await owner(req, playlistId);
    if (!found) return bad("Only the playlist owner can change sharing.", 403);
    const { sb, user, data: playlist } = found;
    const ownerEmail = cleanEmail(user.email);
    const ownerName = String(playlist.user_name || user.email || "Someone");

    if (action === "settings") {
      // Full grant replace when the client sends grants[]; otherwise visibility-only
      // (legacy) plus optional publicPreset.
      let grants: PlaylistGrant[] = Array.isArray(body.grants)
        ? body.grants.map(shapeGrantRow)
        : [];

      if (!Array.isArray(body.grants)) {
        const visibility = ["private", "shared", "public"].includes(body.visibility)
          ? body.visibility
          : "private";
        const existing = (await loadGrants(sb, [playlistId])).map(shapeGrantRow);
        const named = existing.filter(g => g.principal !== PUBLIC_PRINCIPAL);
        if (visibility === "public") {
          const preset = ["listen", "add", "reorder"].includes(body.publicPreset)
            ? body.publicPreset
            : "listen";
          grants = [publicPresetGrant(preset), ...named];
        } else if (visibility === "shared") {
          grants = named.length ? named : [];
        } else {
          grants = [];
        }
      }

      const result = await replaceGrants(sb, playlistId, grants, ownerEmail);
      return NextResponse.json({
        ok: true,
        visibility: result.visibility,
        grants: result.grants,
        publicPreset: presetFromPublicGrant(result.grants.find(g => g.principal === PUBLIC_PRINCIPAL)),
      });
    }

    if (action === "list-grants" || action === "list-invites") {
      const grantRows = await loadGrants(sb, [playlistId]);
      const grants = grantRows.map(shapeGrantRow);
      return NextResponse.json({
        ok: true,
        grants,
        recipients: grants
          .filter(g => g.principal !== PUBLIC_PRINCIPAL)
          .map(g => ({
            recipient_email: g.principal,
            can_view: g.canView,
            can_add: g.canAdd,
            can_reorder: g.canReorder,
          })),
        publicPreset: presetFromPublicGrant(grants.find(g => g.principal === PUBLIC_PRINCIPAL)),
        visibility: visibilityFromGrants(grants),
      });
    }

    if (action === "invite" || action === "upsert-grant") {
      if (rateLimited(`playlist-share-invite:${user.id}`, 12, 60_000)) {
        return bad("Please wait a moment before sending another invitation.", 429);
      }
      const email = cleanEmail(body.email);
      if (email === PUBLIC_PRINCIPAL || !/^\S+@\S+\.\S+$/.test(email)) {
        return bad("Enter a valid email address.");
      }
      if (email === ownerEmail) return bad("You already own this playlist.");

      const flags = normalizeGrantFlags({
        canView: body.canView !== false,
        canAdd: !!body.canAdd,
        canReorder: !!body.canReorder,
      });
      const existing = (await loadGrants(sb, [playlistId])).map(shapeGrantRow);
      const had = existing.some(g => g.principal === email);
      const next = [
        ...existing.filter(g => g.principal !== email),
        { principal: email, ...flags },
      ];
      const result = await replaceGrants(sb, playlistId, next, ownerEmail);
      const emailResult = had
        ? { sent: false, reason: "Updated permissions for that person." }
        : await sendShareEmail(email, playlist.name || "a playlist", ownerName);
      return NextResponse.json({
        ok: true,
        email,
        emailSent: emailResult.sent,
        emailNotice: emailResult.reason || null,
        grants: result.grants,
        visibility: result.visibility,
      });
    }

    if (action === "remove-invite" || action === "remove-grant") {
      const email = cleanEmail(body.email);
      const existing = (await loadGrants(sb, [playlistId])).map(shapeGrantRow);
      const next = existing.filter(g => g.principal !== email);
      const result = await replaceGrants(sb, playlistId, next, ownerEmail);
      return NextResponse.json({ ok: true, grants: result.grants, visibility: result.visibility });
    }

    return bad("Unknown share action.");
  } catch (error) {
    console.error("[playlist-share]", error);
    return bad("Could not update playlist sharing.", 500);
  }
}
