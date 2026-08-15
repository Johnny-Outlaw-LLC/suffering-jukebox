import { NextRequest, NextResponse } from "next/server";
import { cleanText, isUuid } from "@/lib/artist-rights";
import { createSjServiceClient, JUKEBOX_SCHEMA, verifySjAdmin } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  try {
    const sb = createSjServiceClient();
    const { data: agreements, error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    if (!agreements?.length) return NextResponse.json({ ok: true, applications: [] });

    const agreementIds = agreements.map((row) => row.id);
    const artistIds = [...new Set(agreements.map((row) => row.artist_id))];
    const [{ data: catalogTracks, error: trackError }, { data: artists, error: artistError }] =
      await Promise.all([
        sb
          .schema(JUKEBOX_SCHEMA)
          .from("artist_catalog_tracks")
          .select("*")
          .in("agreement_id", agreementIds)
          .order("created_at", { ascending: true }),
        sb.schema(JUKEBOX_SCHEMA).from("artists").select("id,name,slug").in("id", artistIds),
      ]);
    if (trackError) throw trackError;
    if (artistError) throw artistError;

    const trackIds = [...new Set((catalogTracks ?? []).map((row) => row.track_id))];
    const { data: tracks, error: namesError } = trackIds.length
      ? await sb
          .schema(JUKEBOX_SCHEMA)
          .from("tracks")
          .select("id,name,album_id,track_number,duration_ms")
          .in("id", trackIds)
      : { data: [], error: null };
    if (namesError) throw namesError;
    const artistMap = new Map((artists ?? []).map((row) => [row.id, row]));
    const trackMap = new Map((tracks ?? []).map((row) => [row.id, row]));
    return NextResponse.json({
      ok: true,
      applications: agreements.map((agreement) => ({
        ...agreement,
        artist: artistMap.get(agreement.artist_id) ?? null,
        tracks: (catalogTracks ?? [])
          .filter((row) => row.agreement_id === agreement.id)
          .map((row) => ({ ...row, track: trackMap.get(row.track_id) ?? null })),
      })),
    });
  } catch (error) {
    console.error("[sj-admin-artist-rights:get]", error);
    return NextResponse.json({ ok: false, error: "Could not load artist applications." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await verifySjAdmin(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json();
    const agreementId = String(body.agreementId || "");
    const action = String(body.action || "");
    const reviewNote = cleanText(body.reviewNote, 2000, true) as string;
    if (!isUuid(agreementId) || !["approve", "reject", "suspend", "restore", "revoke"].includes(action)) {
      return NextResponse.json({ ok: false, error: "Invalid review action." }, { status: 400 });
    }
    if (reviewNote.length < 12) {
      return NextResponse.json({ ok: false, error: "Record a meaningful verification or review note." }, { status: 400 });
    }
    if (action === "approve" && body.verifiedAuthority !== true) {
      return NextResponse.json(
        { ok: false, error: "Confirm that the artist's authority was independently verified." },
        { status: 400 },
      );
    }

    const sb = createSjServiceClient();
    const { data: current, error: currentError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .select("id,status,user_id,user_email,artist_id")
      .eq("id", agreementId)
      .single();
    if (currentError || !current) {
      return NextResponse.json({ ok: false, error: "Application not found." }, { status: 404 });
    }
    const transitions: Record<string, { from: string[]; to: string; track: string }> = {
      approve: { from: ["pending"], to: "approved", track: "approved" },
      reject: { from: ["pending"], to: "rejected", track: "rejected" },
      suspend: { from: ["approved"], to: "suspended", track: "suspended" },
      restore: { from: ["suspended"], to: "approved", track: "approved" },
      revoke: { from: ["pending", "approved", "suspended"], to: "revoked", track: "withdrawn" },
    };
    const transition = transitions[action];
    if (!transition.from.includes(current.status)) {
      return NextResponse.json(
        { ok: false, error: `Cannot ${action} an application in ${current.status} status.` },
        { status: 409 },
      );
    }
    const now = new Date().toISOString();
    const agreementUpdate: Record<string, unknown> = {
      status: transition.to,
      review_note: reviewNote,
      reviewed_by: auth.user.id,
      reviewed_at: now,
      updated_at: now,
    };
    if (action === "revoke") agreementUpdate.revoked_at = now;
    const { error: updateError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .update(agreementUpdate)
      .eq("id", agreementId)
      .eq("status", current.status);
    if (updateError) throw updateError;
    const trackUpdate: Record<string, unknown> = { status: transition.track, updated_at: now };
    if (["approve", "restore"].includes(action)) {
      trackUpdate.approved_by = auth.user.id;
      trackUpdate.approved_at = now;
    }
    const { error: trackError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_catalog_tracks")
      .update(trackUpdate)
      .eq("agreement_id", agreementId);
    if (trackError) throw trackError;
    await sb.schema(JUKEBOX_SCHEMA).from("artist_rights_events").insert({
      agreement_id: agreementId,
      actor_user_id: auth.user.id,
      actor_email: auth.user.email ?? null,
      event_type: action,
      from_status: current.status,
      to_status: transition.to,
      note: reviewNote,
      details: { independentlyVerified: action === "approve" ? true : undefined },
    });
    return NextResponse.json({ ok: true, agreementId, status: transition.to });
  } catch (error: any) {
    console.error("[sj-admin-artist-rights:patch]", error);
    return NextResponse.json(
      { ok: false, error: error?.message === "A required field is missing." ? error.message : "Could not update the application." },
      { status: 500 },
    );
  }
}

