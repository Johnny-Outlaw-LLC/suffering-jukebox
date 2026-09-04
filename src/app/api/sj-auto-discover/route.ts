// Batch Rediscover: find higher-view YouTube uploads for album tracks and
// promote them as play default + chart source after the owner confirms.
import { NextRequest, NextResponse } from "next/server";
import {
  createSjServiceClient,
  fetchYouTubePlaylistItems,
  fetchYouTubeVideoInfo,
  getAuthUser,
  isSjAdmin,
  searchYouTubePlaylists,
  searchYouTubeVideoIds,
  JUKEBOX_SCHEMA,
  type YtVideoInfo,
} from "@/lib/sj-admin-auth";
import { labelForDiscoveredVideo, recordTrackVideo } from "@/lib/track-videos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE_WINDOW_MS = 60_000;
const PREVIEW_MAX = 4;
const APPLY_MAX = 4;
const TRACK_SEARCH_CAP = 20;
/** YouTube search.list units are expensive (~100 each). 40/day ≈ 4,000 units. */
export const DAILY_SEARCH_LIMIT = 40;
export const DAILY_SEARCH_LIMIT_ADMIN = 200;
const previewHits = new Map<string, number[]>();
const applyHits = new Map<string, number[]>();

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readQuota(
  sb: ReturnType<typeof createSjServiceClient>,
  email: string,
  admin: boolean,
) {
  const limit = admin ? DAILY_SEARCH_LIMIT_ADMIN : DAILY_SEARCH_LIMIT;
  const day = utcDay();
  const { data } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("yt_search_quota")
    .select("searches")
    .eq("user_email", email.toLowerCase())
    .eq("day", day)
    .maybeSingle();
  const used = Number(data?.searches) || 0;
  return { day, used, limit, remaining: Math.max(0, limit - used) };
}

async function consumeQuota(
  sb: ReturnType<typeof createSjServiceClient>,
  email: string,
  admin: boolean,
  n: number,
): Promise<{ ok: true; used: number; limit: number; remaining: number } | { ok: false; error: string; used: number; limit: number; remaining: number }> {
  if (n <= 0) {
    const q = await readQuota(sb, email, admin);
    return { ok: true, ...q };
  }
  const q = await readQuota(sb, email, admin);
  if (q.remaining < n) {
    return {
      ok: false,
      error: `Daily YouTube search limit reached (${q.used}/${q.limit}). Try again tomorrow.`,
      used: q.used,
      limit: q.limit,
      remaining: q.remaining,
    };
  }
  const next = q.used + n;
  const { error } = await sb.schema(JUKEBOX_SCHEMA).from("yt_search_quota").upsert(
    {
      user_email: email.toLowerCase(),
      day: q.day,
      searches: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_email,day" },
  );
  if (error) {
    console.error("[sj-auto-discover:quota]", error);
    // Fail open on quota write so a table blip does not strand Rediscover.
    return { ok: true, used: next, limit: q.limit, remaining: Math.max(0, q.limit - next) };
  }
  return { ok: true, used: next, limit: q.limit, remaining: Math.max(0, q.limit - next) };
}

function rateLimited(map: Map<string, number[]>, key: string, max: number): boolean {
  const now = Date.now();
  const recent = (map.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  map.set(key, recent);
  if (map.size > 4000) {
    for (const [k, v] of map) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) map.delete(k);
    }
  }
  return recent.length > max;
}

function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}

function displayName(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  if (typeof meta.full_name === "string" && meta.full_name.trim()) return meta.full_name.trim();
  if (typeof meta.name === "string" && meta.name.trim()) return meta.name.trim();
  return null;
}

function titleTokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[\[\(\{].*?[\]\)\}]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !["the", "and", "feat", "ft", "official", "video", "audio", "lyrics", "hd", "hq"].includes(t));
}

function titleMatches(trackName: string | null, candidateTitle: string): boolean {
  const want = titleTokens(trackName || "");
  if (!want.length) return true;
  const have = new Set(titleTokens(candidateTitle));
  const hits = want.filter((t) => have.has(t)).length;
  return hits / want.length >= 0.7;
}

function pickBest(
  candidates: string[],
  info: Record<string, YtVideoInfo>,
  artistName: string | null,
  trackName: string | null,
): YtVideoInfo | null {
  const artistLc = (artistName ?? "").toLowerCase().trim();
  const isArtistChannel = (ch: string) => !!artistLc && ch.includes(artistLc);
  const eligible = candidates
    .map((id) => info[id])
    .filter((v): v is YtVideoInfo => !!v && v.playable)
    .filter((v) => titleMatches(trackName, v.title));
  const onArtist = eligible.filter((v) => isArtistChannel(v.channelTitle.toLowerCase()));
  const pool = onArtist.length ? onArtist : eligible;
  const scored = pool
    .map((v) => {
      const ch = v.channelTitle.toLowerCase();
      const mine = isArtistChannel(ch);
      let bonus = 0;
      if (mine && ch.includes(" - topic")) bonus += 3_000_000_000;
      else if (mine && ch.includes("vevo")) bonus += 2_000_000_000;
      else if (mine) bonus += 1_000_000_000;
      return { v, score: bonus + v.views };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.v ?? null;
}

async function canManageArtist(
  sb: ReturnType<typeof createSjServiceClient>,
  artistId: string,
  email: string,
): Promise<boolean> {
  if (await isSjAdmin(email)) return true;
  const { data } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id, added_by")
    .eq("id", artistId)
    .maybeSingle();
  if (!data) return false;
  return !!(data.added_by && String(data.added_by).toLowerCase() === email.toLowerCase());
}

type TrackRow = {
  id: string;
  name: string;
  album_id: string;
  track_number: number | null;
  duration_ms: number | null;
  album_name: string;
  artist_id: string;
  artist_name: string;
  currentViews: number;
  currentVideoId: string | null;
};

async function loadTracks(
  sb: ReturnType<typeof createSjServiceClient>,
  trackIds: string[],
): Promise<TrackRow[]> {
  if (!trackIds.length) return [];
  const { data: tracks } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id, name, album_id, track_number, duration_ms")
    .in("id", trackIds);
  if (!tracks?.length) return [];
  const albumIds = [...new Set(tracks.map((t) => t.album_id).filter(Boolean))];
  const { data: albums } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id, name, artist_id")
    .in("id", albumIds);
  const albumMap = new Map((albums || []).map((a) => [a.id as string, a]));
  const artistIds = [...new Set((albums || []).map((a) => a.artist_id).filter(Boolean))];
  const { data: artists } = artistIds.length
    ? await sb.schema(JUKEBOX_SCHEMA).from("artists").select("id, name").in("id", artistIds)
    : { data: [] as { id: string; name: string }[] };
  const artistMap = new Map((artists || []).map((a) => [a.id as string, a]));

  const { data: videos } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_videos")
    .select("track_id, video_id, view_count, is_primary, is_playable, counts_for_charts")
    .in("track_id", trackIds);

  const byTrack = new Map<string, typeof videos>();
  for (const v of videos || []) {
    const list = byTrack.get(v.track_id as string) || [];
    list.push(v);
    byTrack.set(v.track_id as string, list);
  }

  function chartViews(tid: string): { views: number; videoId: string | null } {
    const list = (byTrack.get(tid) || []).filter(
      (v) => v.is_playable !== false && v.counts_for_charts !== false,
    );
    if (!list.length) {
      const primary = (byTrack.get(tid) || []).find((v) => v.is_primary);
      return { views: Number(primary?.view_count) || 0, videoId: (primary?.video_id as string) || null };
    }
    const top = list.reduce((a, b) =>
      Number(b.view_count || 0) > Number(a.view_count || 0) ? b : a,
    );
    return { views: Number(top.view_count) || 0, videoId: (top.video_id as string) || null };
  }

  return tracks.map((t) => {
    const alb = albumMap.get(t.album_id as string);
    const art = alb ? artistMap.get(alb.artist_id as string) : null;
    const cur = chartViews(t.id as string);
    return {
      id: t.id as string,
      name: (t.name as string) || "",
      album_id: t.album_id as string,
      track_number: t.track_number == null ? null : Number(t.track_number),
      duration_ms: t.duration_ms == null ? null : Number(t.duration_ms),
      album_name: (alb?.name as string) || "",
      artist_id: (alb?.artist_id as string) || "",
      artist_name: (art?.name as string) || "",
      currentViews: cur.views,
      currentVideoId: cur.videoId,
    };
  });
}

type Proposal = {
  trackId: string;
  trackName: string;
  albumId: string;
  albumName: string;
  currentViews: number;
  currentVideoId: string | null;
  proposedVideoId: string | null;
  proposedViews: number;
  proposedTitle: string;
  proposedChannel: string;
  proposedThumbnail: string | null;
  skipped?: string;
};

async function previewSongs(tracks: TrackRow[]): Promise<{ proposals: Proposal[]; searchesUsed: number }> {
  const out: Proposal[] = [];
  let searches = 0;
  for (const t of tracks) {
    if (searches >= TRACK_SEARCH_CAP) {
      out.push({
        trackId: t.id,
        trackName: t.name,
        albumId: t.album_id,
        albumName: t.album_name,
        currentViews: t.currentViews,
        currentVideoId: t.currentVideoId,
        proposedVideoId: null,
        proposedViews: 0,
        proposedTitle: "",
        proposedChannel: "",
        proposedThumbnail: null,
        skipped: "Search budget reached for this run.",
      });
      continue;
    }
    const q = [t.artist_name, t.name].filter(Boolean).join(" ").trim();
    if (!q) {
      out.push({
        trackId: t.id,
        trackName: t.name,
        albumId: t.album_id,
        albumName: t.album_name,
        currentViews: t.currentViews,
        currentVideoId: t.currentVideoId,
        proposedVideoId: null,
        proposedViews: 0,
        proposedTitle: "",
        proposedChannel: "",
        proposedThumbnail: null,
        skipped: "No search query.",
      });
      continue;
    }
    searches += 1;
    const ids = await searchYouTubeVideoIds(q, 5, "viewCount");
    const info = ids.length ? await fetchYouTubeVideoInfo(ids) : {};
    const best = pickBest(ids, info, t.artist_name, t.name);
    if (!best) {
      out.push({
        trackId: t.id,
        trackName: t.name,
        albumId: t.album_id,
        albumName: t.album_name,
        currentViews: t.currentViews,
        currentVideoId: t.currentVideoId,
        proposedVideoId: null,
        proposedViews: 0,
        proposedTitle: "",
        proposedChannel: "",
        proposedThumbnail: null,
        skipped: "No confident match.",
      });
      continue;
    }
    const same = best.id === t.currentVideoId;
    const worse = best.views <= t.currentViews;
    out.push({
      trackId: t.id,
      trackName: t.name,
      albumId: t.album_id,
      albumName: t.album_name,
      currentViews: t.currentViews,
      currentVideoId: t.currentVideoId,
      proposedVideoId: same || worse ? null : best.id,
      proposedViews: best.views,
      proposedTitle: best.title,
      proposedChannel: best.channelTitle,
      proposedThumbnail: best.thumbnail,
      skipped: same ? "Already on this video." : worse ? "Current video has as many or more views." : undefined,
    });
  }
  return { proposals: out, searchesUsed: searches };
}

async function previewPlaylists(tracks: TrackRow[]): Promise<{ proposals: Proposal[]; searchesUsed: number }> {
  const byAlbum = new Map<string, TrackRow[]>();
  for (const t of tracks) {
    const list = byAlbum.get(t.album_id) || [];
    list.push(t);
    byAlbum.set(t.album_id, list);
  }
  const out: Proposal[] = [];
  let searches = 0;
  for (const [, albumTracks] of byAlbum) {
    const sample = albumTracks[0];
    const q = [sample.artist_name, sample.album_name].filter(Boolean).join(" ").trim();
    let items: { videoId: string; title: string; channelTitle: string; thumbnail: string | null }[] = [];
    if (q && searches < TRACK_SEARCH_CAP) {
      searches += 1;
      const pls = await searchYouTubePlaylists(q, 5);
      const artistLc = sample.artist_name.toLowerCase();
      const albumLc = sample.album_name.toLowerCase();
      const ranked = pls
        .map((p) => {
          const title = (p.title || "").toLowerCase();
          let score = 0;
          if (albumLc && title.includes(albumLc.slice(0, Math.min(12, albumLc.length)))) score += 5;
          if (artistLc && (p.channelTitle || "").toLowerCase().includes(artistLc)) score += 3;
          if (p.itemCount != null) {
            const diff = Math.abs(p.itemCount - albumTracks.length);
            score += Math.max(0, 3 - diff);
          }
          return { p, score };
        })
        .sort((a, b) => b.score - a.score);
      const bestPl = ranked[0]?.p;
      if (bestPl) {
        const fetched = await fetchYouTubePlaylistItems(bestPl.playlistId);
        items = fetched.items;
      }
    }
    const videoIds = items.map((i) => i.videoId);
    const info = videoIds.length ? await fetchYouTubeVideoInfo(videoIds) : {};
    for (const t of albumTracks) {
      let best: YtVideoInfo | null = null;
      if (items.length) {
        const matched = items.filter((i) => titleMatches(t.name, i.title)).map((i) => i.videoId);
        best = pickBest(matched.length ? matched : items.map((i) => i.videoId), info, t.artist_name, t.name);
      }
      if (!best) {
        const songQ = [t.artist_name, t.name].filter(Boolean).join(" ").trim();
        if (songQ && searches < TRACK_SEARCH_CAP) {
          searches += 1;
          const ids = await searchYouTubeVideoIds(songQ, 5, "viewCount");
          const songInfo = ids.length ? await fetchYouTubeVideoInfo(ids) : {};
          best = pickBest(ids, songInfo, t.artist_name, t.name);
        }
      }
      if (!best) {
        out.push({
          trackId: t.id,
          trackName: t.name,
          albumId: t.album_id,
          albumName: t.album_name,
          currentViews: t.currentViews,
          currentVideoId: t.currentVideoId,
          proposedVideoId: null,
          proposedViews: 0,
          proposedTitle: "",
          proposedChannel: "",
          proposedThumbnail: null,
          skipped: "No confident match.",
        });
        continue;
      }
      const same = best.id === t.currentVideoId;
      const worse = best.views <= t.currentViews;
      out.push({
        trackId: t.id,
        trackName: t.name,
        albumId: t.album_id,
        albumName: t.album_name,
        currentViews: t.currentViews,
        currentVideoId: t.currentVideoId,
        proposedVideoId: same || worse ? null : best.id,
        proposedViews: best.views,
        proposedTitle: best.title,
        proposedChannel: best.channelTitle,
        proposedThumbnail: best.thumbnail,
        skipped: same ? "Already on this video." : worse ? "Current video has as many or more views." : undefined,
      });
    }
  }
  return { proposals: out, searchesUsed: searches };
}

function albumTotals(proposals: Proposal[]) {
  const map = new Map<string, { albumId: string; albumName: string; before: number; after: number }>();
  for (const p of proposals) {
    const row = map.get(p.albumId) || {
      albumId: p.albumId,
      albumName: p.albumName,
      before: 0,
      after: 0,
    };
    row.before += p.currentViews || 0;
    const next = p.proposedVideoId ? p.proposedViews : p.currentViews;
    row.after += next || 0;
    map.set(p.albumId, row);
  }
  return [...map.values()];
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) {
    return NextResponse.json({ ok: false, error: "Sign in to rediscover videos." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action =
    body?.action === "apply" ? "apply"
      : body?.action === "quota" ? "quota"
        : "preview";
  const strategy = body?.strategy === "playlist" ? "playlist" : "songs";
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  // Apply used to send only `changes` and the handler required `track_ids`,
  // which made every Apply fail with "Pick at least one song."
  let trackIds = Array.isArray(body?.track_ids)
    ? body.track_ids.map((id: unknown) => uuid(id)).filter(Boolean).slice(0, 80) as string[]
    : [];
  if (!trackIds.length && changes.length) {
    trackIds = [...new Set(
      changes
        .map((ch: { trackId?: unknown; track_id?: unknown }) => uuid(ch?.trackId ?? ch?.track_id))
        .filter(Boolean),
    )].slice(0, 80) as string[];
  }

  const who = user.email.toLowerCase();
  const sb = createSjServiceClient();
  const admin = await isSjAdmin(user.email);

  if (action === "quota") {
    const q = await readQuota(sb, who, admin);
    return NextResponse.json({ ok: true, quota: q });
  }

  if (!trackIds.length) {
    return NextResponse.json({ ok: false, error: "Pick at least one song." }, { status: 400 });
  }

  if (action === "preview" && rateLimited(previewHits, who, PREVIEW_MAX)) {
    return NextResponse.json({ ok: false, error: "Easy there — give Rediscover a second." }, { status: 429 });
  }
  if (action === "apply" && rateLimited(applyHits, who, APPLY_MAX)) {
    return NextResponse.json({ ok: false, error: "Easy there — give Rediscover a second." }, { status: 429 });
  }

  const tracks = await loadTracks(sb, trackIds);
  if (!tracks.length) {
    return NextResponse.json({ ok: false, error: "No tracks found." }, { status: 404 });
  }

  const artistIds = [...new Set(tracks.map((t) => t.artist_id).filter(Boolean))];
  for (const aid of artistIds) {
    if (!(await canManageArtist(sb, aid, user.email))) {
      return NextResponse.json({ ok: false, error: "You can only rediscover music you imported." }, { status: 403 });
    }
  }

  try {
    if (action === "preview") {
      // Estimate worst-case searches for this run before spending quota.
      const estimate = strategy === "playlist"
        ? Math.min(TRACK_SEARCH_CAP, Math.max(1, new Set(tracks.map((t) => t.album_id)).size))
        : Math.min(TRACK_SEARCH_CAP, tracks.length);
      const reserved = await consumeQuota(sb, who, admin, estimate);
      if (!reserved.ok) {
        return NextResponse.json({
          ok: false,
          error: reserved.error,
          quota: { used: reserved.used, limit: reserved.limit, remaining: reserved.remaining },
        }, { status: 429 });
      }

      const result = strategy === "playlist"
        ? await previewPlaylists(tracks)
        : await previewSongs(tracks);

      // Refund unused reserved units (estimate − actual).
      const refund = Math.max(0, estimate - result.searchesUsed);
      let quota = reserved;
      if (refund > 0) {
        const q = await readQuota(sb, who, admin);
        const next = Math.max(0, q.used - refund);
        await sb.schema(JUKEBOX_SCHEMA).from("yt_search_quota").upsert(
          {
            user_email: who,
            day: q.day,
            searches: next,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_email,day" },
        );
        quota = { ok: true, used: next, limit: q.limit, remaining: Math.max(0, q.limit - next) };
      } else {
        quota = await readQuota(sb, who, admin).then((q) => ({ ok: true as const, ...q }));
      }

      return NextResponse.json({
        ok: true,
        strategy,
        proposals: result.proposals,
        albums: albumTotals(result.proposals),
        searchesUsed: result.searchesUsed,
        quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
      });
    }

    // apply — body.changes: [{ trackId, videoId }]
    const applied: { trackId: string; videoId: string; views: number }[] = [];
    for (const ch of changes.slice(0, TRACK_SEARCH_CAP)) {
      const trackId = uuid(ch?.trackId ?? ch?.track_id);
      const videoId = typeof (ch?.videoId ?? ch?.video_id) === "string"
        ? String(ch.videoId ?? ch.video_id).trim()
        : "";
      if (!trackId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
      const track = tracks.find((t) => t.id === trackId);
      if (!track) continue;
      const info = (await fetchYouTubeVideoInfo([videoId]))[videoId];
      if (!info || !info.playable) continue;
      const label = labelForDiscoveredVideo(info.title, info.channelTitle, track.artist_name);
      await recordTrackVideo(
        sb,
        trackId,
        {
          videoId,
          title: info.title,
          channel: info.channelTitle,
          thumbnail: info.thumbnail,
          views: info.views,
          likes: info.likes,
          playable: true,
          label,
        },
        {
          makePrimary: true,
          source: "auto-discover",
          addedBy: user.email,
          addedByName: displayName(user.user_metadata as Record<string, unknown> | undefined),
          artistName: track.artist_name,
          countsForCharts: true,
        },
      );
      // Ensure charts flag even if the row already existed with charts off.
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("track_videos")
        .update({ counts_for_charts: true, is_primary: true })
        .eq("track_id", trackId)
        .eq("video_id", videoId);
      await sb
        .schema(JUKEBOX_SCHEMA)
        .from("track_videos")
        .update({ is_primary: false })
        .eq("track_id", trackId)
        .neq("video_id", videoId);
      applied.push({ trackId, videoId, views: info.views });
    }

    return NextResponse.json({ ok: true, applied });
  } catch (err) {
    console.error("[sj-auto-discover]", err);
    const msg = err instanceof Error ? err.message : "Could not talk to YouTube.";
    if (/not configured/i.test(msg)) {
      return NextResponse.json({ ok: false, error: "YouTube search is not configured." }, { status: 500 });
    }
    return NextResponse.json({ ok: false, error: "Could not rediscover videos right now." }, { status: 500 });
  }
}
