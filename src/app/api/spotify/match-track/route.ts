import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";
import { clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { artistMatches, normTitle, titleMatches } from "@/lib/catalog-index";
import {
  canStream,
  freshSpotifySession,
  sealSpotifySession,
  spotifyApi,
  spotifyCookieOptions,
  spotifySessionFor,
  SPOTIFY_SESSION_COOKIE,
} from "@/lib/spotify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SpotTrack = {
  id: string;
  name: string;
  uri: string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  duration_ms?: number;
};

function pickBest(
  items: SpotTrack[],
  title: string,
  artist: string,
  durationMs: number | null,
): SpotTrack | null {
  if (!items.length) return null;
  let best: SpotTrack | null = null;
  let bestScore = -1;
  for (const item of items) {
    const spTitle = item.name || "";
    const spArtist = (item.artists || []).map((a) => a.name || "").filter(Boolean).join(" ");
    if (!titleMatches(title, spTitle) && !titleMatches(spTitle, title)) continue;
    if (artist && !artistMatches(artist, spArtist) && !artistMatches(spArtist, artist)) continue;
    let score = 10;
    if (normTitle(spTitle) === normTitle(title)) score += 5;
    if (artist && normTitle(spArtist).includes(normTitle(artist))) score += 3;
    if (durationMs != null && item.duration_ms != null) {
      const delta = Math.abs(item.duration_ms - durationMs);
      if (delta <= 2000) score += 4;
      else if (delta <= 8000) score += 1;
      else if (delta > 25000) score -= 4;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 10 ? best : null;
}

async function loadTrackMeta(trackId: string) {
  const sb = createSjServiceClient();
  const { data: track } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("tracks")
    .select("id,name,duration_ms,album_id")
    .eq("id", trackId)
    .maybeSingle();
  if (!track?.album_id) return null;
  const { data: album } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("albums")
    .select("id,name,artist_id")
    .eq("id", track.album_id)
    .maybeSingle();
  if (!album?.artist_id) return null;
  const { data: artist } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id,name")
    .eq("id", album.artist_id)
    .maybeSingle();
  if (!artist) return null;

  const { data: cached } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("track_spotify_matches")
    .select("spotify_uri,spotify_id,spotify_name,spotify_artist,miss")
    .eq("track_id", trackId)
    .maybeSingle();

  return {
    track: track as { id: string; name: string; duration_ms: number | null },
    album: album as { id: string; name: string },
    artist: artist as { id: string; name: string },
    cached: cached as {
      spotify_uri: string | null;
      spotify_id: string | null;
      spotify_name: string | null;
      spotify_artist: string | null;
      miss: boolean | null;
    } | null,
  };
}

async function saveMatch(
  trackId: string,
  hit: { uri: string; id: string; name: string; artist: string } | null,
) {
  const sb = createSjServiceClient();
  const row = {
    track_id: trackId,
    spotify_uri: hit?.uri || null,
    spotify_id: hit?.id || null,
    spotify_name: hit?.name || null,
    spotify_artist: hit?.artist || null,
    miss: !hit,
    matched_at: new Date().toISOString(),
  };
  await sb.schema(JUKEBOX_SCHEMA).from("track_spotify_matches").upsert(row, { onConflict: "track_id" });
}

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`spotify-match:${clientIp(req)}`, 30)) return tooMany();
    const user = await getAuthUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
    const found = spotifySessionFor(req, user.id);
    if (!found) return NextResponse.json({ ok: false, error: "Connect Spotify first." }, { status: 401 });
    if (!canStream(found.session)) {
      return NextResponse.json({ ok: false, error: "Reconnect Spotify for playback.", reconnect: true }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as { track_id?: string; force?: boolean };
    const trackId = String(body.track_id || "");
    if (!UUID.test(trackId)) return NextResponse.json({ ok: false, error: "track_id required." }, { status: 400 });

    const meta = await loadTrackMeta(trackId);
    if (!meta) return NextResponse.json({ ok: false, error: "Track not found." }, { status: 404 });

    if (!body.force && meta.cached) {
      if (meta.cached.miss) {
        return NextResponse.json({ ok: true, matched: false, uri: null, cached: true });
      }
      if (meta.cached.spotify_uri) {
        return NextResponse.json({
          ok: true,
          matched: true,
          cached: true,
          uri: meta.cached.spotify_uri,
          id: meta.cached.spotify_id,
          name: meta.cached.spotify_name,
          artist: meta.cached.spotify_artist,
        });
      }
    }

    const { session, refreshed } = await freshSpotifySession(found.session, found.config);
    const q = `track:${meta.track.name} artist:${meta.artist.name}`;
    const data = await spotifyApi<{ tracks?: { items?: SpotTrack[] } }>(
      `https://api.spotify.com/v1/search?type=track&limit=10&q=${encodeURIComponent(q)}`,
      session.accessToken,
    );
    const best = pickBest(
      data.tracks?.items || [],
      meta.track.name,
      meta.artist.name,
      meta.track.duration_ms,
    );

    if (!best) {
      try { await saveMatch(trackId, null); } catch (e) { console.error("[spotify:match:save]", e); }
      const response = NextResponse.json({ ok: true, matched: false, uri: null, cached: false });
      if (refreshed) {
        response.cookies.set(
          SPOTIFY_SESSION_COOKIE,
          sealSpotifySession(session, found.sealSecret),
          spotifyCookieOptions(req, 180 * 24 * 60 * 60),
        );
      }
      return response;
    }

    const artistName = (best.artists || []).map((a) => a.name || "").filter(Boolean).join(", ");
    try {
      await saveMatch(trackId, {
        uri: best.uri,
        id: best.id,
        name: best.name,
        artist: artistName,
      });
    } catch (e) {
      console.error("[spotify:match:save]", e);
    }

    const response = NextResponse.json({
      ok: true,
      matched: true,
      cached: false,
      uri: best.uri,
      id: best.id,
      name: best.name,
      artist: artistName,
    });
    if (refreshed) {
      response.cookies.set(
        SPOTIFY_SESSION_COOKIE,
        sealSpotifySession(session, found.sealSecret),
        spotifyCookieOptions(req, 180 * 24 * 60 * 60),
      );
    }
    return response;
  } catch (error) {
    console.error("[spotify:match-track]", error);
    return NextResponse.json({ ok: false, error: "Could not match that song on Spotify." }, { status: 500 });
  }
}
