// Nightly proof that every artist upload plays for the public, on both brands.
// See src/lib/artist-audio-health.ts for why it fetches real bytes rather than
// reading the database.
//
// Called by pg_cron job `jukebox-artist-audio-health` with SJ_CRON_SECRET, or by
// an admin. Emails ARTIST_AUDIO_ALERT_TO (default the owner) only when something
// fails. `?test_alert=1` sends the email regardless, to prove delivery works.

import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, isSjAdmin } from "@/lib/sj-admin-auth";
import { SURFACES } from "@/lib/surface";
import {
  artistAudioAlertHtml,
  checkArtistAudio,
  publicArtistAudioSongs,
  type ArtistAudioReport,
} from "@/lib/artist-audio-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_ALERT_TO = "johnnyoutlawllc@gmail.com";

async function authorize(req: NextRequest) {
  const cronSecret = process.env.SJ_CRON_SECRET?.trim();
  const header = req.headers.get("authorization")?.trim();
  if (cronSecret && header === `Bearer ${cronSecret}`) return true;
  const user = await getAuthUser(req);
  return !!user?.email && (await isSjAdmin(user.email));
}

async function sendAlert(report: ArtistAudioReport, test: boolean) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return { sent: false, reason: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured." };
  const to = (process.env.ARTIST_AUDIO_ALERT_TO || DEFAULT_ALERT_TO).split(",").map((s) => s.trim()).filter(Boolean);
  const subject = test
    ? `Test: artist audio check (${report.failures.length} failing)`
    : `Artist uploads not playing: ${report.failures.length} of ${report.checks} checks failed`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html: artistAudioAlertHtml(report) }),
  });
  if (!r.ok) {
    console.error("[sj-artist-audio-health:email]", r.status, await r.text());
    return { sent: false, reason: `Resend answered ${r.status}` };
  }
  return { sent: true };
}

async function run(req: NextRequest) {
  if (!(await authorize(req))) {
    return NextResponse.json({ ok: false, error: "Not authorized." }, { status: 401 });
  }
  const test = req.nextUrl.searchParams.get("test_alert") === "1";
  const sb = createSjServiceClient();
  const songs = await publicArtistAudioSongs(sb);
  const report = await checkArtistAudio(songs, [SURFACES.sj.url, SURFACES.lp.url]);
  const alert = report.failures.length || test ? await sendAlert(report, test) : { sent: false, reason: "all passing" };
  if (report.failures.length) console.error("[sj-artist-audio-health]", JSON.stringify(report.failures));
  return NextResponse.json(
    { ok: report.failures.length === 0, ...report, alert },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(req: NextRequest) {
  try { return await run(req); }
  catch (e) {
    console.error("[sj-artist-audio-health]", e);
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export const POST = GET;
