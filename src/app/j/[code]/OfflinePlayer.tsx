"use client";

// Interactive Jukebox — listening after closing time.
//
// The Stage is a mirror: no transport, because a guest scrubbing their own
// phone would only desynchronise themselves. This is the opposite. Nobody is
// broadcasting, so there is nothing to keep step with, and the visitor gets a
// real player — play, skip, pick any song — over the last running order the
// host actually had on air.
//
// It is deliberately a separate component rather than a mode on Stage. The two
// have opposite rules about who is in charge of the clock, and folding them
// together is how a mirror ends up with a seek bar.

import { useCallback, useEffect, useRef, useState } from "react";
import { loadYouTubeApi } from "./Stage";
import css from "./guest.module.css";

export type OfflineTrack = {
  trackId: string;
  videoId: string | null;
  trackName: string;
  artistName: string | null;
  albumName: string | null;
  albumArt: string | null;
  addedByName: string | null;
};

export default function OfflinePlayer({
  tracks,
  onClose,
}: {
  tracks: OfflineTrack[];
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The advance handler is rebuilt on every index change, but the player is
  // built once, so onStateChange has to reach the current one through a ref
  // rather than closing over a stale copy.
  const advanceRef = useRef<() => void>(() => {});
  advanceRef.current = () => setIdx((i) => (i + 1 < tracks.length ? i + 1 : 0));

  const current = tracks[idx] ?? null;

  useEffect(() => {
    let dead = false;
    loadYouTubeApi().then((YT) => {
      if (dead || !hostRef.current || playerRef.current) return;
      playerRef.current = new YT.Player(hostRef.current, {
        host: "https://www.youtube-nocookie.com",
        videoId: tracks[0]?.videoId ?? undefined,
        playerVars: { modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: (e: any) => {
            // Unmuted on purpose: this one is not a lyric sheet beside a set of
            // speakers, it is the only thing playing. A browser that refuses
            // the autoplay leaves it paused and the play button starts it.
            try {
              e.target.playVideo();
            } catch {
              setPlaying(false);
            }
          },
          onStateChange: (e: any) => {
            if (e.data === 0) advanceRef.current();
            if (e.data === 1) setPlaying(true);
            if (e.data === 2) setPlaying(false);
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
    };
    // Built once. Track changes go through loadVideoById below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = playerRef.current;
    const videoId = tracks[idx]?.videoId;
    if (!p || !videoId || typeof p.loadVideoById !== "function") return;
    try {
      p.loadVideoById(videoId);
    } catch {
      /* the next pick tries again */
    }
  }, [idx, tracks]);

  // Keep the playing row in the list rather than scrolling the page: the
  // visitor may be halfway down looking for the next thing to pick.
  useEffect(() => {
    const body = listRef.current;
    if (!body) return;
    const el = body.querySelector(`[data-i="${idx}"]`) as HTMLElement | null;
    if (!el) return;
    const er = el.getBoundingClientRect();
    const cr = body.getBoundingClientRect();
    if (er.top < cr.top || er.bottom > cr.bottom) {
      body.scrollTop += er.top - cr.top - cr.height / 3;
    }
  }, [idx]);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    try {
      if (playing) p?.pauseVideo?.();
      else p?.playVideo?.();
    } catch {
      /* pressing it again retries */
    }
  }, [playing]);

  const step = useCallback(
    (delta: number) => {
      setIdx((i) => {
        const next = i + delta;
        if (next < 0) return tracks.length - 1;
        if (next >= tracks.length) return 0;
        return next;
      });
    },
    [tracks.length],
  );

  return (
    <section className={css.stage}>
      <div className={css.stageVideo}>
        <div ref={hostRef} className={css.stageFrame} />
      </div>

      <div className={css.stageBar}>
        <div className={css.rowBody}>
          <div className={css.stageTitle}>{current?.trackName ?? "Nothing to play"}</div>
          <div className={css.stageSub}>
            {[current?.artistName, current?.albumName].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className={css.transport}>
          <button className={css.tBtn} onClick={() => step(-1)} aria-label="Previous song">
            ⏮
          </button>
          <button className={`${css.tBtn} ${css.tBtnMain}`} onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className={css.tBtn} onClick={() => step(1)} aria-label="Next song">
            ⏭
          </button>
        </div>
      </div>

      <div className={css.offlineBar}>
        <span>
          Playing on this device · {idx + 1} of {tracks.length}
        </span>
        <button className={css.linkBtn} style={{ margin: 0 }} onClick={onClose}>
          Stop and go back
        </button>
      </div>

      <div className={css.offlineList} ref={listRef}>
        {tracks.map((t, i) => (
          <button
            key={`${t.trackId}-${i}`}
            data-i={i}
            className={`${css.row} ${css.offlineRow} ${i === idx ? css.offlineRowOn : ""}`}
            onClick={() => setIdx(i)}
          >
            <div className={css.pos}>{i + 1}</div>
            <div className={css.rowBody}>
              <div className={css.rowTitle}>{t.trackName}</div>
              <div className={css.rowSub}>
                {t.artistName}
                {t.addedByName ? (
                  <>
                    {" · "}
                    <span className={css.by}>Added by {t.addedByName}</span>
                  </>
                ) : null}
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
