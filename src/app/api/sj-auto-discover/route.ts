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
const previewHits = new Map<string, number[]>();
const applyHits = new Map<string, number[]>();

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

async function previewSongs(tracks: TrackRow[]): Promise<Proposal[]> {
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
  return out;
}

async function previewPlaylists(tracks: TrackRow[]): Promise<Proposal[]> {
  const byAlbum = new Map<string, TrackRow[]>();
  for (const t of tracks) {
    const list = byAlbum.get(t.album_id) || [];
    list.push(t);
    byAlbum.set(t.album_id, list);
  }
  const out: Proposal[] = [];
  let playlistSearches = 0;
  for (const [, albumTracks] of byAlbum) {
    const sample = albumTracks[0];
    const q = [sample.artist_name, sample.album_name].filter(Boolean).join(" ").trim();
    let items: { videoId: string; title: string; channelTitle: string; thumbnail: string | null }[] = [];
    if (q && playlistSearches < 8) {
      playlistSearches += 1;
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
        // Fall back to a single song search if the playlist did not cover this track.
        const songQ = [t.artist_name, t.name].filter(Boolean).join(" ").trim();
        if (songQ) {
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
  return out;
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
  const action = body?.action === "apply" ? "apply" : "preview";
  const strategy = body?.strategy === "playlist" ? "playlist" : "songs";
  const trackIds = Array.isArray(body?.track_ids)
    ? body.track_ids.map((id: unknown) => uuid(id)).filter(Boolean).slice(0, 80) as string[]
    : [];
  if (!trackIds.length) {
    return NextResponse.json({ ok: false, error: "Pick at least one song." }, { status: 400 });
  }

  const who = user.email.toLowerCase();
  if (action === "preview" && rateLimited(previewHits, who, PREVIEW_MAX)) {
    return NextResponse.json({ ok: false, error: "Easy there — give Rediscover a second." }, { status: 429 });
  }
  if (action === "apply" && rateLimited(applyHits, who, APPLY_MAX)) {
    return NextResponse.json({ ok: false, error: "Easy there — give Rediscover a second." }, { status: 429 });
  }

  const sb = createSjServiceClient();
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
      const proposals = strategy === "playlist"
        ? await previewPlaylists(tracks)
        : await previewSongs(tracks);
      return NextResponse.json({
        ok: true,
        strategy,
        proposals,
        albums: albumTotals(proposals),
      });
    }

    // apply — body.changes: [{ trackId, videoId }]
    const changes = Array.isArray(body?.changes) ? body.changes : [];
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
