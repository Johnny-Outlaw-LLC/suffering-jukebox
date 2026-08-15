import { NextRequest, NextResponse } from "next/server";
import { loadUserArtistCatalog } from "@/lib/artist-catalog";
import {
  ARTIST_AGREEMENT_SHA256,
  ARTIST_AGREEMENT_VERSION,
  artistAgreementPayload,
  cleanText,
  isUuid,
  requestAuditMeta,
} from "@/lib/artist-rights";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

const REQUIRED_CONFIRMATIONS = [
  "ownsSoundRecordings",
  "controlsCompositions",
  "clearedContributors",
  "clearedSamples",
  "clearedArtwork",
  "originalCatalogOnly",
  "grantConfirmed",
  "dmcaConfirmed",
  "accurateInformationConfirmed",
] as const;

async function applicationsForUser(userId: string) {
  const sb = createSjServiceClient();
  const { data: agreements, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artist_rights_agreements")
    .select(
      "id,artist_id,legal_name,stage_name,organization,authority_role,country,website,catalog_description,agreement_version,agreement_sha256,signed_name,signed_at,status,review_note,reviewed_at,revoked_at,created_at,updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!agreements?.length) return [];

  const artistIds = [...new Set(agreements.map((row) => row.artist_id))];
  const agreementIds = agreements.map((row) => row.id);
  const [{ data: artists, error: artistError }, { data: tracks, error: trackError }] =
    await Promise.all([
      sb.schema(JUKEBOX_SCHEMA).from("artists").select("id,name,slug").in("id", artistIds),
      sb
        .schema(JUKEBOX_SCHEMA)
        .from("artist_catalog_tracks")
        .select("id,agreement_id,track_id,status,master_owner,composition_owner,writers,publishers,isrc,rights_notes,approved_at")
        .in("agreement_id", agreementIds),
    ]);
  if (artistError) throw artistError;
  if (trackError) throw trackError;
  const artistMap = new Map((artists ?? []).map((row) => [row.id, row]));
  return agreements.map((agreement) => {
    const ownTracks = (tracks ?? []).filter((row) => row.agreement_id === agreement.id);
    return {
      ...agreement,
      artist: artistMap.get(agreement.artist_id) ?? null,
      trackCount: ownTracks.length,
      approvedTrackCount: ownTracks.filter((row) => row.status === "approved").length,
      tracks: ownTracks,
    };
  });
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("agreement") === "1") {
    return NextResponse.json({ ok: true, agreement: artistAgreementPayload() });
  }
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  try {
    const sb = createSjServiceClient();
    const [catalog, applications] = await Promise.all([
      loadUserArtistCatalog(sb, user.id),
      applicationsForUser(user.id),
    ]);
    return NextResponse.json({
      ok: true,
      account: { id: user.id, email: user.email ?? null },
      catalog,
      applications,
      agreement: artistAgreementPayload(),
    });
  } catch (error) {
    console.error("[sj-artist-rights:get]", error);
    return NextResponse.json({ ok: false, error: "Could not load artist rights data." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "A signed-in email account is required." }, { status: 401 });
  }
  try {
    const body = await req.json();
    const artistId = String(body.artistId || "");
    if (!isUuid(artistId)) {
      return NextResponse.json({ ok: false, error: "Choose a valid artist catalog." }, { status: 400 });
    }
    for (const field of REQUIRED_CONFIRMATIONS) {
      if (body[field] !== true) {
        return NextResponse.json(
          { ok: false, error: "Every rights confirmation must be affirmatively accepted." },
          { status: 400 },
        );
      }
    }

    const legalName = cleanText(body.legalName, 160, true) as string;
    const signedName = cleanText(body.signedName, 160, true) as string;
    if (legalName.toLocaleLowerCase() !== signedName.toLocaleLowerCase()) {
      return NextResponse.json(
        { ok: false, error: "Your electronic signature must exactly match your legal name." },
        { status: 400 },
      );
    }
    const stageName = cleanText(body.stageName, 160, true) as string;
    const authorityRole = cleanText(body.authorityRole, 120, true) as string;
    const country = cleanText(body.country, 100, true) as string;
    const contactPhone = cleanText(body.contactPhone, 80, true) as string;
    const website = cleanText(body.website, 500);
    if (website) {
      try {
        const parsed = new URL(website);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol");
      } catch {
        return NextResponse.json({ ok: false, error: "Website must be a complete http(s) URL." }, { status: 400 });
      }
    }

    const sb = createSjServiceClient();
    const catalog = await loadUserArtistCatalog(sb, user.id);
    const selected = catalog.find((group) => group.artist.id === artistId);
    if (!selected?.tracks.length) {
      return NextResponse.json(
        { ok: false, error: "Upload private audio for this artist before submitting a catalog license." },
        { status: 400 },
      );
    }
    const { data: existing } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .select("id,status")
      .eq("user_id", user.id)
      .eq("artist_id", artistId)
      .in("status", ["pending", "approved", "suspended"])
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { ok: false, error: `This artist already has an active ${existing.status} application.` },
        { status: 409 },
      );
    }

    const submission = {
      artistId,
      artistName: selected.artist.name,
      trackIds: selected.tracks.map((track: any) => track.trackId),
      legalName,
      stageName,
      organization: cleanText(body.organization, 200),
      authorityRole,
      country,
      website,
      contactPhone,
      catalogDescription: cleanText(body.catalogDescription, 2000),
      masterOwner: cleanText(body.masterOwner, 200, true),
      compositionOwner: cleanText(body.compositionOwner, 200, true),
      writers: cleanText(body.writers, 1000),
      publishers: cleanText(body.publishers, 1000),
      rightsNotes: cleanText(body.rightsNotes, 2000),
      confirmations: Object.fromEntries(REQUIRED_CONFIRMATIONS.map((key) => [key, true])),
    };
    const audit = requestAuditMeta(req);
    const agreementSnapshot = {
      agreement: artistAgreementPayload(),
      submission,
    };
    const { data: agreement, error: agreementError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .insert({
        user_id: user.id,
        artist_id: artistId,
        user_email: user.email.toLowerCase(),
        legal_name: legalName,
        stage_name: stageName,
        organization: submission.organization,
        authority_role: authorityRole,
        country,
        website,
        contact_phone: contactPhone,
        catalog_description: submission.catalogDescription,
        owns_sound_recordings: true,
        controls_compositions: true,
        cleared_contributors: true,
        cleared_samples: true,
        cleared_artwork: true,
        original_catalog_only: true,
        grant_confirmed: true,
        dmca_confirmed: true,
        accurate_information_confirmed: true,
        agreement_version: ARTIST_AGREEMENT_VERSION,
        agreement_sha256: ARTIST_AGREEMENT_SHA256,
        agreement_snapshot: agreementSnapshot,
        signed_name: signedName,
        signature_ip: audit.ip,
        signature_user_agent: audit.userAgent,
        status: "pending",
      })
      .select("id,status,signed_at")
      .single();
    if (agreementError || !agreement) throw agreementError ?? new Error("Agreement was not created.");

    const trackRows = selected.tracks.map((track: any) => ({
      agreement_id: agreement.id,
      track_audio_id: track.trackAudioId,
      track_id: track.trackId,
      user_id: user.id,
      artist_id: artistId,
      master_owner: submission.masterOwner,
      composition_owner: submission.compositionOwner,
      writers: submission.writers,
      publishers: submission.publishers,
      rights_notes: submission.rightsNotes,
      status: "pending",
    }));
    const { error: trackError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_catalog_tracks")
      .insert(trackRows);
    if (trackError) {
      await sb.schema(JUKEBOX_SCHEMA).from("artist_rights_agreements").delete().eq("id", agreement.id);
      throw trackError;
    }
    await sb.schema(JUKEBOX_SCHEMA).from("artist_rights_events").insert({
      agreement_id: agreement.id,
      actor_user_id: user.id,
      actor_email: user.email.toLowerCase(),
      event_type: "submitted",
      to_status: "pending",
      details: { trackCount: trackRows.length, agreementVersion: ARTIST_AGREEMENT_VERSION },
    });
    return NextResponse.json(
      {
        ok: true,
        application: agreement,
        trackCount: trackRows.length,
        message: "Catalog license submitted for manual verification. Nothing is public yet.",
      },
      { status: 201 },
    );
  } catch (error: any) {
    console.error("[sj-artist-rights:post]", error);
    return NextResponse.json(
      { ok: false, error: error?.message === "A required field is missing." ? error.message : "Could not submit the catalog license." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  try {
    const body = await req.json();
    const agreementId = String(body.agreementId || "");
    if (!isUuid(agreementId) || body.action !== "withdraw") {
      return NextResponse.json({ ok: false, error: "Invalid withdrawal request." }, { status: 400 });
    }
    const sb = createSjServiceClient();
    const { data: current, error: currentError } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .select("id,status")
      .eq("id", agreementId)
      .eq("user_id", user.id)
      .in("status", ["pending", "approved", "suspended"])
      .single();
    if (currentError || !current) {
      return NextResponse.json({ ok: false, error: "Active application not found." }, { status: 404 });
    }
    const now = new Date().toISOString();
    const { error } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_rights_agreements")
      .update({ status: "withdrawn", revoked_at: now, updated_at: now })
      .eq("id", agreementId)
      .eq("user_id", user.id);
    if (error) throw error;
    await sb
      .schema(JUKEBOX_SCHEMA)
      .from("artist_catalog_tracks")
      .update({ status: "withdrawn", updated_at: now })
      .eq("agreement_id", agreementId);
    await sb.schema(JUKEBOX_SCHEMA).from("artist_rights_events").insert({
      agreement_id: agreementId,
      actor_user_id: user.id,
      actor_email: user.email ?? null,
      event_type: "withdrawn",
      from_status: current.status,
      to_status: "withdrawn",
    });
    return NextResponse.json({ ok: true, status: "withdrawn" });
  } catch (error) {
    console.error("[sj-artist-rights:patch]", error);
    return NextResponse.json({ ok: false, error: "Could not withdraw the application." }, { status: 500 });
  }
}

