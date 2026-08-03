import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  createSjServiceClient,
  fetchYouTubeVideoInfo,
  searchYouTubeVideoIds,
  getAuthUser,
  isSjAdmin,
  JUKEBOX_SCHEMA,
  type YtVideoInfo,
} from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type IssueRow = {
  id: string;
  category: string | null;
  description: string | null;
  track_id: string | null;
  video_id: string | null;
  track_name: string | null;
  artist_name: string | null;
  album_name: string | null;
};

// Phrases people copy out of the YouTube player when a video refuses to play in
// an embed. If a report says any of this, we do not accept "the API says it's
// fine" as proof — we go looking for a replacement instead, and if we can't find
// one we leave the report open for a human rather than closing it.
const EMBED_BLOCK_SIGNS = [
  "age-restricted",
  "age restricted",
  "confirm your age",
  "only available on youtube",
  "watch on youtube",
  "playback on other websites",
  "video unavailable",
  "unavailable",
  "not available",
  "restricted",
  "blocked",
  "won't play",
  "wont play",
  "will not play",
  "doesn't play",
  "does not play",
  "not playing",
  "no longer available",
  "error 101",
  "error 150",
];

function looksLikeEmbedBlock(description: string | null): boolean {
  const d = (description || "").toLowerCase();
  if (!d) return false;
  return EMBED_BLOCK_SIGNS.some((s) => d.includes(s));
}

// ── Authorization: the nightly cron sends a shared secret; admins send a JWT ──
async function authorize(req: NextRequest): Promise<
  { ok: true; actor: string } | { ok: false; res: NextResponse }
> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const cronSecret = process.env.SJ_CRON_SECRET?.trim();
  if (cronSecret && bearer && bearer === cronSecret) {
    return { ok: true, actor: "auto" };
  }
  const user = await getAuthUser(req);
  if (!user?.email) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 }) };
  }
  if (!(await isSjAdmin(user.email))) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 }) };
  }
  return { ok: true, actor: "auto" };
}

// Latest YouTube video id currently mapped to a track (newest metric wins).
async function currentVideoId(sb: ReturnType<typeof createSjServiceClient>, trackId: string): Promise<string | null> {
  const { data } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("metrics")
    .select("metric_text_value, metric_date")
    .eq("metric_source", "youtube")
    .eq("metric_name", "youtube_video_id")
    .eq("track_id", trackId)
    .order("metric_date", { ascending: false })
    .limit(1);
  return data?.[0]?.metric_text_value ?? null;
}

// Track context for building a good search query.
async function trackContext(
  sb: ReturnType<typeof createSjServiceClient>,
  trackId: string,
): Promise<{ trackName: string | null; artistName: string | null; albumId: string | null }> {
  const { data: track } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("name, album_id")
    .eq("id", trackId)
    .maybeSingle();
  if (!track) return { trackName: null, artistName: null, albumId: null };
  let artistName: string | null = null;
  if (track.album_id) {
    const { data: album } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("albums")
      .select("artist_id")
      .eq("id", track.album_id)
      .maybeSingle();
    if (album?.artist_id) {
      const { data: artist } = await sb
        .schema(JUKEBOX_SCHEMA)
        .from("artists")
        .select("name")
        .eq("id", album.artist_id)
        .maybeSingle();
      artistName = artist?.name ?? null;
    }
  }
  return { trackName: track.name ?? null, artistName, albumId: track.album_id ?? null };
}

// Normalize a title/track name for comparison: drop parentheticals, common
// video-noise words and year/remaster tags, keep alphanumeric word tokens.
function titleTokens(s: string): string[] {
  const norm = (s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(official|video|audio|lyric|lyrics|hd|hq|mv|m\/v|remaster(ed)?|version|feat|ft|\d{4})\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return norm.split(" ").filter((t) => t.length > 1);
}

// Does a candidate video title plausibly correspond to the track we're fixing?
// Requires most of the track-name words to appear in the candidate title, so we
// never silently swap in a different song (e.g. right artist, wrong track).
function titleMatches(trackName: string | null, candidateTitle: string): boolean {
  const want = titleTokens(trackName || "");
  if (!want.length) return true; // no track name to check against
  const have = new Set(titleTokens(candidateTitle));
  const hits = want.filter((t) => have.has(t)).length;
  return hits / want.length >= 0.7;
}

// Score candidates: require a title match, then prefer official audio ("Topic") /
// VEVO / artist-named channels, then views. Returns null if nothing is confident.
function pickBestReplacement(
  candidates: string[],
  info: Record<string, YtVideoInfo>,
  artistName: string | null,
  trackName: string | null,
): YtVideoInfo | null {
  const artistLc = (artistName ?? "").toLowerCase();
  const scored = candidates
    .map((id) => info[id])
    .filter((v): v is YtVideoInfo => !!v && v.playable)
    .filter((v) => titleMatches(trackName, v.title))
    .map((v) => {
      const ch = v.channelTitle.toLowerCase();
      let bonus = 0;
      if (ch.includes(" - topic")) bonus += 3_000_000_000;
      else if (ch.includes("vevo")) bonus += 2_000_000_000;
      else if (artistLc && ch.includes(artistLc)) bonus += 1_000_000_000;
      return { v, score: bonus + v.views };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.v ?? null;
}

async function writeVideoMetrics(
  sb: ReturnType<typeof createSjServiceClient>,
  trackId: string,
  albumId: string | null,
  v: YtVideoInfo,
) {
  const syncRunId = randomUUID();
  const now = new Date().toISOString();
  await sb.schema(JUKEBOX_SCHEMA).from("sync_runs").insert({
    id: syncRunId,
    pulled_at: now,
    source: "youtube_autoresolve",
    album_count: 0,
    track_count: 1,
    notes: `Auto-resolve replaced broken video for track ${trackId}`,
  });
  const base = {
    pull_id: syncRunId,
    metric_source: "youtube",
    metric_date: now,
    metric_type: "track",
    track_id: trackId,
    album_id: albumId,
    artist_id: null as string | null,
  };
  const rows = [
    { ...base, id: randomUUID(), metric_name: "youtube_video_id", metric_value: null, metric_text_value: v.id },
    { ...base, id: randomUUID(), metric_name: "youtube_views", metric_value: v.views, metric_text_value: null },
    { ...base, id: randomUUID(), metric_name: "youtube_likes", metric_value: v.likes, metric_text_value: null },
    { ...base, id: randomUUID(), metric_name: "youtube_thumbnail", metric_value: null, metric_text_value: v.thumbnail },
    { ...base, id: randomUUID(), metric_name: "youtube_title", metric_value: null, metric_text_value: v.title },
    { ...base, id: randomUUID(), metric_name: "youtube_channel", metric_value: null, metric_text_value: v.channelTitle },
  ];
  await sb.schema(JUKEBOX_SCHEMA).from("metrics").insert(rows);
}

async function logEvent(
  sb: ReturnType<typeof createSjServiceClient>,
  issue: IssueRow,
  kind: string,
  detail: string,
) {
  await sb.schema(JUKEBOX_SCHEMA).from("issue_events").insert({
    issue_id: issue.id,
    kind,
    actor: "auto",
    category: issue.category,
    track_name: issue.track_name,
    artist_name: issue.artist_name,
    album_name: issue.album_name,
    detail,
  });
}

async function resolveIssues(
  sb: ReturnType<typeof createSjServiceClient>,
  ids: string[],
  fields: Record<string, unknown>,
) {
  await sb
    .schema(JUKEBOX_SCHEMA)
    .from("issues")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .in("id", ids);
}

async function runAutoResolve() {
  const sb = createSjServiceClient();
  const summary = {
    checked_tracks: 0,
    verified_ok: 0,
    fixed: 0,
    flagged: 0,
    skipped: 0,
    details: [] as string[],
  };

  const { data: openIssues, error } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("issues")
    .select("id, category, description, track_id, video_id, track_name, artist_name, album_name")
    .eq("resolved", false);
  if (error) throw error;

  const issues = (openIssues ?? []) as IssueRow[];

  // Only playback reports tied to a track can be auto-fixed. Others stay open.
  const fixable: IssueRow[] = [];
  for (const it of issues) {
    if (it.category === "playback" && it.track_id) fixable.push(it);
    else summary.skipped++;
  }

  // Group by track so multiple reports on the same track resolve together.
  const byTrack = new Map<string, IssueRow[]>();
  for (const it of fixable) {
    const arr = byTrack.get(it.track_id!) ?? [];
    arr.push(it);
    byTrack.set(it.track_id!, arr);
  }

  for (const [trackId, group] of byTrack) {
    summary.checked_tracks++;
    const ids = group.map((g) => g.id);
    const label = group[0].track_name || trackId;
    try {
      const vid = (await currentVideoId(sb, trackId)) || group[0].video_id;
      const nowIso = new Date().toISOString();

      if (!vid) {
        // No video mapped at all — needs a human/catalog fix.
        await resolveIssues(sb, ids, { last_auto_attempt_at: nowIso, resolution_note: "No YouTube video is mapped to this track." });
        for (const it of group) await maybeFlag(sb, it, "No YouTube video is mapped to this track yet.");
        summary.flagged++;
        summary.details.push(`Flagged "${label}" — no video mapped`);
        continue;
      }

      const info = await fetchYouTubeVideoInfo([vid]);
      const cur = info[vid];
      // Somebody described an embed failure. Even if YouTube's metadata looks
      // clean, do not close the report on that alone.
      const reportedBlock = group.some((g) => looksLikeEmbedBlock(g.description));

      if (cur && cur.playable && !reportedBlock) {
        await resolveIssues(sb, ids, {
          resolved: true,
          resolved_at: nowIso,
          resolved_by: "auto",
          auto_resolved: true,
          resolution_kind: "verified_ok",
          old_video_id: vid,
          resolution_note: "Video verified playable — likely a temporary network or player hiccup.",
          last_auto_attempt_at: nowIso,
        });
        for (const it of group)
          await logEvent(sb, it, "auto_verified", `"${it.track_name ?? "This track"}" checked out fine and is playing normally.`);
        summary.verified_ok++;
        summary.details.push(`Verified "${label}" playable`);
        continue;
      }

      // Broken — find a working replacement.
      const reason =
        cur?.reason ||
        (cur ? "reported as unplayable in the embedded player" : "video removed from YouTube");
      const ctx = await trackContext(sb, trackId);
      const query = [ctx.artistName || group[0].artist_name || "", ctx.trackName || label]
        .filter(Boolean)
        .join(" ")
        .trim();
      const candidates = query ? await searchYouTubeVideoIds(query) : [];
      const candInfo = candidates.length ? await fetchYouTubeVideoInfo(candidates) : {};
      // Never "replace" with the same broken id.
      const best = pickBestReplacement(
        candidates.filter((c) => c !== vid),
        candInfo,
        ctx.artistName || group[0].artist_name,
        ctx.trackName || group[0].track_name,
      );

      if (best) {
        await writeVideoMetrics(sb, trackId, ctx.albumId, best);
        await resolveIssues(sb, ids, {
          resolved: true,
          resolved_at: nowIso,
          resolved_by: "auto",
          auto_resolved: true,
          resolution_kind: "revideo",
          old_video_id: vid,
          new_video_id: best.id,
          resolution_note: `Original video was ${reason}. Swapped in a version that plays here, from "${best.channelTitle}".`,
          last_auto_attempt_at: nowIso,
        });
        for (const it of group)
          await logEvent(
            sb,
            it,
            "auto_fixed",
            `Fixed playback for "${it.track_name ?? "a track"}" — replaced the unavailable video (${reason}) with a working one.`,
          );
        summary.fixed++;
        summary.details.push(`Fixed "${label}" (${reason}) → ${best.id}`);
      } else {
        await resolveIssues(sb, ids, {
          last_auto_attempt_at: nowIso,
          old_video_id: vid,
          resolution_note: cur?.playable
            ? "Reported as unplayable in the player. YouTube still lists the video as fine and no better version turned up, so this one needs a person to look at it."
            : `Original video was ${reason}, but no working replacement was found automatically.`,
        });
        for (const it of group)
          await maybeFlag(
            sb,
            it,
            cur?.playable
              ? `"${it.track_name ?? "A track"}" was reported as unplayable and no working replacement was found yet — flagged for review.`
              : `Video for "${it.track_name ?? "a track"}" is ${reason}; no automatic replacement found yet — flagged for review.`,
          );
        summary.flagged++;
        summary.details.push(`Flagged "${label}" (${reason}) — no replacement found`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      summary.details.push(`Error on "${label}": ${msg}`);
    }
  }

  return summary;
}

// Only emit a fresh "flagged" history event if we haven't flagged this issue in the last ~20h,
// so nightly re-runs don't spam the Updates feed.
async function maybeFlag(
  sb: ReturnType<typeof createSjServiceClient>,
  issue: IssueRow,
  detail: string,
) {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("issue_events")
    .select("id")
    .eq("issue_id", issue.id)
    .eq("kind", "auto_flagged")
    .gte("at", cutoff)
    .limit(1);
  if (data && data.length) return;
  await logEvent(sb, issue, "auto_flagged", detail);
}

export async function POST(req: NextRequest) {
  const auth = await authorize(req);
  if (!auth.ok) return auth.res;
  try {
    const summary = await runAutoResolve();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Auto-resolve failed.";
    console.error("[sj-issue-autoresolve]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
