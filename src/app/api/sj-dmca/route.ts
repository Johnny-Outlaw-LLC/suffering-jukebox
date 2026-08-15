import { NextRequest, NextResponse } from "next/server";
import { cleanText, isUuid, requestAuditMeta } from "@/lib/artist-rights";
import { createSjServiceClient, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    intake: "support@outlawapps.online",
    acceptedTypes: ["takedown", "counter_notice"],
    message: "Use the form at /dmca. Submissions are recorded for manual review.",
  });
}

export async function POST(req: NextRequest) {
  try {
    if (Number(req.headers.get("content-length") || 0) > 100_000) {
      return NextResponse.json({ ok: false, error: "Notice is too large." }, { status: 413 });
    }
    const body = await req.json();
    if (body.companyWebsite) {
      return NextResponse.json({ ok: true, reference: "received" }, { status: 202 });
    }
    const noticeType = body.noticeType === "counter_notice" ? "counter_notice" : "takedown";
    if (body.goodFaithConfirmed !== true || body.accuracyConfirmed !== true) {
      return NextResponse.json(
        { ok: false, error: "The required good-faith and accuracy statements must be accepted." },
        { status: 400 },
      );
    }
    if (
      noticeType === "counter_notice" &&
      (body.jurisdictionConfirmed !== true || body.serviceAccepted !== true)
    ) {
      return NextResponse.json(
        { ok: false, error: "A counter-notice requires the jurisdiction and service statements." },
        { status: 400 },
      );
    }
    const targetTrackId = body.targetTrackId ? String(body.targetTrackId) : null;
    if (targetTrackId && !isUuid(targetTrackId)) {
      return NextResponse.json({ ok: false, error: "Track ID is not valid." }, { status: 400 });
    }

    const sb = createSjServiceClient();
    let parentNoticeId: string | null = null;
    if (noticeType === "counter_notice") {
      const parentReference = cleanText(body.parentReference, 80, true) as string;
      const { data: parent, error } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("copyright_notices")
        .select("id")
        .eq("reference_code", parentReference.toUpperCase())
        .maybeSingle();
      if (error || !parent) {
        return NextResponse.json({ ok: false, error: "Original notice reference was not found." }, { status: 404 });
      }
      parentNoticeId = parent.id;
    }
    const audit = requestAuditMeta(req);
    const { data, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("copyright_notices")
      .insert({
        notice_type: noticeType,
        claimant_name: cleanText(body.claimantName, 200, true),
        claimant_organization: cleanText(body.claimantOrganization, 200),
        claimant_email: cleanText(body.claimantEmail, 320, true),
        claimant_phone: cleanText(body.claimantPhone, 80, true),
        claimant_address: cleanText(body.claimantAddress, 1000, true),
        copyrighted_work_description: cleanText(body.copyrightedWorkDescription, 5000, true),
        material_location: cleanText(body.materialLocation, 3000, true),
        target_track_id: targetTrackId,
        good_faith_confirmed: true,
        accuracy_confirmed: true,
        jurisdiction_confirmed: noticeType === "counter_notice",
        service_accepted: noticeType === "counter_notice",
        signature_name: cleanText(body.signatureName, 200, true),
        parent_notice_id: parentNoticeId,
        submitted_ip: audit.ip,
        submitted_user_agent: audit.userAgent,
        status: "received",
      })
      .select("reference_code,created_at")
      .single();
    if (error || !data) throw error ?? new Error("Notice was not recorded.");
    return NextResponse.json(
      {
        ok: true,
        reference: data.reference_code,
        receivedAt: data.created_at,
        message: "Your notice was recorded for manual review. Save this reference number.",
      },
      { status: 201 },
    );
  } catch (error: any) {
    console.error("[sj-dmca:post]", error);
    return NextResponse.json(
      { ok: false, error: error?.message === "A required field is missing." ? error.message : "Could not record the notice." },
      { status: 500 },
    );
  }
}

