"use client";

// Interactive Jukebox — the guest's stage.
//
// The same video, at the same second, with the same lyric line lit up as the
// screen the host is playing on. It is a mirror and nothing else: there are no
// transport controls, because a guest scrubbing their own phone would only
// desynchronise themselves and get snapped back on the next poll.
//
// Sound is muted until the guest asks for it. Every browser blocks autoplay
// with sound, and in the room this is meant for the sound is already coming out
// of the speakers — the phone is a lyric sheet you can also watch.
//
// Time works like this: the server stamps `updatedAt` when the host reports a
// position, and the poll hands back `serverTime`, so the guest can work out how
// far its own clock is from the server's and extrapolate between polls. The
// player is only nudged when it has drifted past DRIFT_MS, so ordinary
// playback is never interrupted.

import { useCallback, useEffect, useRef, useState } from "react";
import css from "./guest.module.css";

export type Playback = {
  videoId: string | null;
  trackId: string | null;
  itemId: string | null;
  title: string | null;
  artistName: string | null;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  lyricOffsetMs: number;
  updatedAt: string | null;
};

type LyricLine = { t: number; text: string };

/** How far out of step before we correct the guest's player. */
const DRIFT_MS = 3500;
const TICK_MS = 250;

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;

/** One script tag for the page, however many times this component mounts. */
export function loadYouTubeApi(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiPromise;
}

export default function Stage({
  code,
  playback,
  serverOffsetMs,
}: {
  code: string;
  playback: Playback;
  /** Local clock minus server clock, in ms, measured on the last poll. */
  serverOffsetMs: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const loadedVideo = useRef<string | null>(null);
  // The poll is every few seconds but the tick is four times a second, so the
  // latest playback has to be readable from inside the tick without restarting
  // the interval on every render.
  const pbRef = useRef(playback);
  const offsetRef = useRef(serverOffsetMs);
  pbRef.current = playback;
  offsetRef.current = serverOffsetMs;

  const [sound, setSound] = useState(false);
  const [lines, setLines] = useState<LyricLine[] | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [showLyrics, setShowLyrics] = useState(true);
  const lyricBodyRef = useRef<HTMLDivElement | null>(null);

  /** Where the host is right now, by our clock. */
  const expectedMs = useCallback(() => {
    const pb = pbRef.current;
    if (!pb.updatedAt) return pb.positionMs;
    const stampedAt = Date.parse(pb.updatedAt);
    if (!Number.isFinite(stampedAt)) return pb.positionMs;
    if (!pb.isPlaying) return pb.positionMs;
    const elapsed = Date.now() - offsetRef.current - stampedAt;
    const at = pb.positionMs + Math.max(0, elapsed);
    return pb.durationMs > 0 ? Math.min(at, pb.durationMs) : at;
  }, []);

  // ── The player ──────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    loadYouTubeApi().then((YT) => {
      if (dead || !hostRef.current || playerRef.current) return;
      playerRef.current = new YT.Player(hostRef.current, {
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: (e: any) => {
            readyRef.current = true;
            e.target.mute();
          },
        },
      });
    });
    return () => {
      dead = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* the iframe is going away with the page anyway */
      }
      playerRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // ── Keeping step ────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current;
      const pb = pbRef.current;
      if (!p || !readyRef.current) return;

      if (!pb.videoId) {
        if (loadedVideo.current) {
          try {
            p.stopVideo();
          } catch {
            /* nothing playing is not an error */
          }
          loadedVideo.current = null;
        }
        return;
      }

      const want = expectedMs() / 1000;

      if (loadedVideo.current !== pb.videoId) {
        loadedVideo.current = pb.videoId;
        try {
          p.loadVideoById({ videoId: pb.videoId, startSeconds: Math.max(0, want) });
          if (!sound) p.mute();
        } catch {
          loadedVideo.current = null;
        }
        return;
      }

      let at: number;
      try {
        at = p.getCurrentTime();
      } catch {
        return;
      }
      if (typeof at !== "number" || Number.isNaN(at)) return;

      if (pb.isPlaying && Math.abs(at * 1000 - want * 1000) > DRIFT_MS) {
        try {
          p.seekTo(Math.max(0, want), true);
        } catch {
          /* the next tick tries again */
        }
      }

      let state = -1;
      try {
        state = p.getPlayerState();
      } catch {
        return;
      }
      // 1 playing, 2 paused, 3 buffering. Buffering is left alone: pressing
      // play into a buffering player is how you get a stutter loop.
      if (pb.isPlaying && state === 2) {
        try {
          p.playVideo();
        } catch {
          /* autoplay may still be blocked; the sound button fixes it */
        }
      } else if (!pb.isPlaying && state === 1) {
        try {
          p.pauseVideo();
        } catch {
          /* next tick */
        }
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [expectedMs, sound]);

  // ── Lyrics ──────────────────────────────────────────────────────────
  // Keyed on the track alone, with no "have I already asked for this" ref:
  // React runs an effect twice in development, and a ref guard turns the
  // second run into a no-op after the first has already been cancelled, which
  // is a lyric pane that silently stays empty.
  useEffect(() => {
    const trackId = playback.trackId;
    setLines(null);
    setPlain(null);
    setActive(-1);
    if (!trackId) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/jukebox/lyrics?code=${encodeURIComponent(code)}&trackId=${encodeURIComponent(trackId)}`,
        );
        const d = await res.json();
        if (dead || !d.ok) return;
        setLines(d.synced ?? null);
        setPlain(d.plain ?? null);
      } catch {
        /* no lyrics is a normal outcome, not an error worth showing */
      }
    })();
    return () => {
      dead = true;
    };
  }, [playback.trackId, code]);

  // The highlight prefers the guest's own player clock — it is the thing the
  // guest is actually watching — and falls back to the extrapolation while the
  // player is still coming up.
  useEffect(() => {
    if (!lines?.length) return;
    const id = setInterval(() => {
      let at: number | null = null;
      try {
        const t = playerRef.current?.getCurrentTime?.();
        if (typeof t === "number" && !Number.isNaN(t) && t > 0) at = t;
      } catch {
        at = null;
      }
      if (at == null) at = expectedMs() / 1000;
      const adjusted = at - pbRef.current.lyricOffsetMs / 1000;
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].t <= adjusted + 0.3) idx = i;
        else break;
      }
      setActive((prev) => (prev === idx ? prev : idx));
    }, 300);
    return () => clearInterval(id);
  }, [lines, expectedMs]);

  // Scroll the lyric scroller itself, never scrollIntoView: that walks
  // ancestors and would drag the whole page around under the guest's thumb.
  useEffect(() => {
    const body = lyricBodyRef.current;
    if (!body || active < 0) return;
    const el = body.querySelector(`[data-i="${active}"]`) as HTMLElement | null;
    if (!el) return;
    const er = el.getBoundingClientRect();
    const cr = body.getBoundingClientRect();
    body.scrollTop += er.top + er.height / 2 - (cr.top + cr.height / 2);
  }, [active]);

  const toggleSound = useCallback(() => {
    const p = playerRef.current;
    setSound((on) => {
      const next = !on;
      try {
        if (next) {
          p?.unMute?.();
          p?.setVolume?.(100);
          if (pbRef.current.isPlaying) p?.playVideo?.();
        } else {
          p?.mute?.();
        }
      } catch {
        /* the button is the only way to ask; if it fails, tapping again retries */
      }
      return next;
    });
  }, []);

  const title = playback.title ?? "";
  const artist = playback.artistName ?? "";
  const hasWords = !!(lines?.length || plain);

  return (
    <section className={css.stage}>
      <div className={css.stageVideo}>
        <div ref={hostRef} className={css.stageFrame} />
        {/* Swallows taps so a guest cannot scrub their mirror out of step.
            Tapping is how you turn the sound on instead. */}
        <button
          className={css.stageShield}
          onClick={toggleSound}
          aria-label={sound ? "Mute this phone" : "Play the sound on this phone"}
        />
        <button className={`${css.soundBtn} ${sound ? css.soundOn : ""}`} onClick={toggleSound}>
          {sound ? "Sound on" : "Tap for sound"}
        </button>
      </div>

      <div className={css.stageBar}>
        <div className={css.rowBody}>
          <div className={css.stageTitle}>{title || "Nothing playing"}</div>
          <div className={css.stageSub}>{artist}</div>
        </div>
        {hasWords && (
          <button className={css.smallBtn} onClick={() => setShowLyrics((v) => !v)}>
            {showLyrics ? "Hide words" : "Words"}
          </button>
        )}
      </div>

      {showLyrics && hasWords && (
        <div className={css.lyricBody} ref={lyricBodyRef}>
          {lines?.length ? (
            lines.map((l, i) => (
              <div
                key={i}
                data-i={i}
                className={`${css.lyricLine} ${i === active ? css.lyricActive : ""}`}
              >
                {l.text || " "}
              </div>
            ))
          ) : (
            <div className={css.lyricPlain}>{plain}</div>
          )}
        </div>
      )}
    </section>
  );
}
