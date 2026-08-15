import { NextRequest, NextResponse } from "next/server";
import { cleanText, isUuid } from "@/lib/artist-rights";
import { createSjServiceClient, JUKEBOX_SCHEMA, verifySjAdmin } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

function addBusinessDays(start: Date, count: number) {
  const result = new Date(start);
  let added = 0;
  while (added < count) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return result;
}

export async function GET(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  try {
    const sb = createSjServiceClient();
    const [{ data: notices, error }, { data: actions, error: actionError }] = await Promise.all([
      sb.schema(JUKEBOX_SCHEMA).from("copyright_notices").select("*").order("created_at", { ascending: false }).limit(500),
      sb.schema(JUKEBOX_SCHEMA).from("copyright_account_actions").select("*").order("created_at", { ascending: false }).limit(500),
    ]);
    if (error) throw error;
    if (actionError) throw actionError;
    return NextResponse.json({ ok: true, notices: notices ?? [], accountActions: actions ?? [] });
  } catch (error) {
    console.error("[sj-admin-dmca:get]", error);
    return NextResponse.json({ ok: false, error: "Could not load copyright notices." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json();
    const action = String(body.action || "");
    const reviewNote = cleanText(body.reviewNote, 3000, true) as string;
    if (reviewNote.length < 12) {
      return NextResponse.json({ ok: false, error: "Record a meaningful review note." }, { status: 400 });
    }
    const sb = createSjServiceClient();
    const now = new Date().toISOString();

    if (action === "terminate") {
      const targetUserId = String(body.targetUserId || "");
      if (!isUuid(targetUserId) || body.confirmation !== "TERMINATE") {
        return NextResponse.json({ ok: false, error: "Termination requires the exact confirmation word." }, { status: 400 });
      }
      if (targetUserId === auth.user.id) {
        return NextResponse.json({ ok: false, error: "You cannot terminate your own admin account." }, { status: 403 });
      }
      const { error: terminationError } = await sb.schema(JUKEBOX_SCHEMA).from("copyright_account_actions").insert({
        notice_id: isUuid(body.noticeId) ? body.noticeId : null,
        target_user_id: targetUserId,
        action_type: "termination",
        reason: reviewNote,
        actor_user_id: auth.user.id,
        actor_email: auth.user.email ?? null,
      });
      if (terminationError) throw terminationError;
      const { error: banError } = await sb.auth.admin.updateUserById(targetUserId, { ban_duration: "876000h" });
      if (banError) throw banError;
      const { data: agreements } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("artist_rights_agreements")
        .select("id,status")
        .eq("user_id", targetUserId)
        .in("status", ["pending", "approved", "suspended"]);
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("artist_rights_agreements")
        .update({ status: "suspended", review_note: reviewNote, reviewed_by: auth.user.id, reviewed_at: now, updated_at: now })
        .eq("user_id", targetUserId)
        .in("status", ["pending", "approved", "suspended"]);
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("artist_catalog_tracks")
        .update({ status: "suspended", updated_at: now })
        .eq("user_id", targetUserId);
      for (const agreement of agreements ?? []) {
        await sb.schema(JUKEBOX_SCHEMA).from("artist_rights_events").insert({
          agreement_id: agreement.id,
          actor_user_id: auth.user.id,
          actor_email: auth.user.email ?? null,
          event_type: "account_terminated",
          from_status: agreement.status,
          to_status: "suspended",
          note: reviewNote,
        });
      }
      return NextResponse.json({ ok: true, action: "terminate", targetUserId });
    }

    const noticeId = String(body.noticeId || "");
    if (!isUuid(noticeId) || ![
      "needs_information",
      "reject",
      "takedown",
      "restore",
      "close",
      "strike",
      "link_track",
      "subscriber_notified",
      "forward_counter",
      "court_action",
    ].includes(action)) {
      return NextResponse.json({ ok: false, error: "Invalid notice action." }, { status: 400 });
    }
    const { data: notice, error: noticeError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("copyright_notices")
      .select("*")
      .eq("id", noticeId)
      .single();
    if (noticeError || !notice) {
      return NextResponse.json({ ok: false, error: "Notice not found." }, { status: 404 });
    }

    if (action === "link_track") {
      const targetTrackId = String(body.targetTrackId || "");
      if (!isUuid(targetTrackId)) {
        return NextResponse.json({ ok: false, error: "Enter a valid catalog track ID." }, { status: 400 });
      }
      const { error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("copyright_notices")
        .update({ target_track_id: targetTrackId, review_note: reviewNote, reviewed_by: auth.user.id, reviewed_at: now, updated_at: now })
        .eq("id", noticeId);
      if (error) throw error;
      return NextResponse.json({ ok: true, noticeId, targetTrackId });
    }

    if (action === "subscriber_notified") {
      const { error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("copyright_notices")
        .update({ subscriber_notified_at: now, review_note: reviewNote, reviewed_by: auth.user.id, reviewed_at: now, updated_at: now })
        .eq("id", noticeId);
      if (error) throw error;
      return NextResponse.json({ ok: true, noticeId, subscriberNotifiedAt: now });
    }

    if (action === "forward_counter") {
      if (notice.notice_type !== "counter_notice" || !notice.parent_notice_id) {
        return NextResponse.json({ ok: false, error: "This is not a linked counter-notice." }, { status: 400 });
      }
      const restoreEligibleAt = addBusinessDays(new Date(), 14).toISOString();
      const { error: counterError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("copyright_notices")
        .update({ status: "actioned", counter_forwarded_at: now, review_note: reviewNote, reviewed_by: auth.user.id, reviewed_at: now, actioned_at: now, updated_at: now })
        .eq("id", noticeId);
      if (counterError) throw counterError;
      const { error: parentError } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("copyright_notices")
        .update({ status: "countered", counter_forwarded_at: now, restore_eligible_at: restoreEligibleAt, review_note: reviewNote, reviewed_by: auth.user.id, reviewed_at: now, updated_at: now })
        .eq("id", notice.parent_notice_id);
      if (parentError) throw parentError;
      return NextResponse.json({ ok: true, noticeId, restoreEligibleAt });
    }

    if (action === "court_action") {
      const parentId = notice.notice_type === "counter_notice" ? notice.parent_notice_id : notice.id;
      if (!parentId) {
        return NextResponse.json({ ok: false, error: "Original notice not found." }, { status: 404 });
      }
      const { error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("copyright_notices")
        .update({ court_action_received_at: now, review_note: reviewNote, reviewed_by: auth.user.id, reviewed_at: now, updated_at: now })
        .eq("id", parentId);
      if (error) throw error;
      return NextResponse.json({ ok: true, noticeId: parentId, courtActionReceivedAt: now });
    }

    let targetUserId = notice.target_user_id as string | null;
    const relatedTracks = notice.target_track_id
      ? (
          await sb
            .schema(JUKEBOX_SCHEMA)
            .from("artist_catalog_tracks")
            .select("id,agreement_id,user_id,status")
            .eq("track_id", notice.target_track_id)
            .in("status", ["approved", "suspended"])
        ).data ?? []
      : [];
    if (!targetUserId) targetUserId = relatedTracks[0]?.user_id ?? null;

    if (action === "takedown") {
      if (!notice.target_track_id) {
        return NextResponse.json({ ok: false, error: "Record a target track before actioning this notice." }, { status: 400 });
      }
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("artist_catalog_tracks")
        .update({ status: "suspended", updated_at: now })
        .eq("track_id", notice.target_track_id)
        .eq("status", "approved");
      if (targetUserId && body.addStrike === true) {
        await sb.schema(JUKEBOX_SCHEMA).from("copyright_account_actions").insert({
          notice_id: noticeId,
          target_user_id: targetUserId,
          action_type: "strike",
          reason: reviewNote,
          actor_user_id: auth.user.id,
          actor_email: auth.user.email ?? null,
        });
      }
    } else if (action === "restore" && notice.target_track_id) {
      if (notice.court_action_received_at) {
        return NextResponse.json({ ok: false, error: "A court action is recorded; do not restore automatically." }, { status: 409 });
      }
      if (notice.restore_eligible_at && new Date(notice.restore_eligible_at).getTime() > Date.now()) {
        return NextResponse.json(
          { ok: false, error: `Counter-notice waiting period runs through ${notice.restore_eligible_at}.` },
          { status: 409 },
        );
      }
      const agreementIds = [...new Set(relatedTracks.map((row) => row.agreement_id))];
      const { data: approvedAgreements } = agreementIds.length
        ? await sb
            .schema(JUKEBOX_SCHEMA)
            .from("artist_rights_agreements")
            .select("id")
            .in("id", agreementIds)
            .eq("status", "approved")
        : { data: [] };
      const approvedIds = (approvedAgreements ?? []).map((row) => row.id);
      if (approvedIds.length) {
        await sb
          .schema(JUKEBOX_SCHEMA)
          .from("artist_catalog_tracks")
          .update({ status: "approved", updated_at: now })
          .eq("track_id", notice.target_track_id)
          .in("agreement_id", approvedIds);
      }
    } else if (action === "strike") {
      if (!targetUserId) {
        return NextResponse.json({ ok: false, error: "No target account is linked to this notice." }, { status: 400 });
      }
      await sb.schema(JUKEBOX_SCHEMA).from("copyright_account_actions").insert({
        notice_id: noticeId,
        target_user_id: targetUserId,
        action_type: "strike",
        reason: reviewNote,
        actor_user_id: auth.user.id,
        actor_email: auth.user.email ?? null,
      });
    }

    const statusByAction: Record<string, string> = {
      needs_information: "needs_information",
      reject: "rejected",
      takedown: "actioned",
      restore: "restored",
      close: "closed",
      strike: notice.status,
      link_track: notice.status,
      subscriber_notified: notice.status,
      forward_counter: notice.status,
      court_action: notice.status,
    };
    const update: Record<string, unknown> = {
      status: statusByAction[action],
      target_user_id: targetUserId,
      review_note: reviewNote,
      reviewed_by: auth.user.id,
      reviewed_at: now,
      updated_at: now,
    };
    if (action === "takedown") update.actioned_at = now;
    const { error: updateError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("copyright_notices")
      .update(update)
      .eq("id", noticeId);
    if (updateError) throw updateError;
    return NextResponse.json({ ok: true, noticeId, status: statusByAction[action], targetUserId });
  } catch (error: any) {
    console.error("[sj-admin-dmca:patch]", error);
    return NextResponse.json(
      { ok: false, error: error?.message === "A required field is missing." ? error.message : "Could not update the notice." },
      { status: 500 },
    );
  }
}
