"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./player.module.css";

type Track = { id: string; name: string; disc: number; number: number; durationMs: number | null;
  explicit: boolean; kind: "audio" | "youtube"; videoId: string | null };
type Release = { id: string; name: string; date: string | null; unreleased: boolean; art: string | null; tracks: Track[] };

export default function CatalogPlayer({ artist, releases }: {
  artist: { name: string; slug: string }; releases: Release[];
}) {
  const [queue, setQueue] = useState<Track[]>([]);
  const [position, setPosition] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const current = queue[position];

  useEffect(() => {
    let active = true;
    setAudioUrl("");
    setError("");
    if (!current || current.kind !== "audio") return;
    const params = new URLSearchParams({ purpose: "normal-playback", track_ids: current.id });
    fetch(`/api/sj-artist-audio?${params}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok || !data.tracks?.[0]?.url) throw new Error(data.error || "Audio is unavailable.");
        if (active) setAudioUrl(data.tracks[0].url);
      })
      .catch(() => { if (active) setError("This recording is temporarily unavailable."); });
    return () => { active = false; };
  }, [current]);

  useEffect(() => {
    if (audioUrl) audio.current?.play().catch(() => undefined);
  }, [audioUrl]);

  function play(release: Release, index: number) {
    setQueue(release.tracks);
    setPosition(index);
  }

  return <main className={styles.page}>
    <header className={styles.header}>
      <a href="/">← Back to the jukebox</a>
      <span>ARTIST CATALOG</span>
      <a href="/artist-upload">Upload music</a>
    </header>
    <section className={styles.hero}>
      <p>Complete listening room</p>
      <h1>{artist.name}</h1>
      <p>Albums, singles, and artist approved recordings. Audio uploads play directly here; available videos play from YouTube.</p>
    </section>
    {current && <section className={styles.player} aria-label="Now playing">
      <div><small>NOW PLAYING · {position + 1} OF {queue.length}</small><strong>{current.name}</strong></div>
      {current.kind === "audio" ? <>
        {error ? <p role="alert">{error}</p> : audioUrl
          ? <audio ref={audio} src={audioUrl} controls autoPlay onEnded={() => setPosition((i) => Math.min(i + 1, queue.length - 1))} />
          : <p>Loading audio…</p>}
      </> : <iframe title={`${current.name} on YouTube`}
        src={`https://www.youtube.com/embed/${current.videoId}?autoplay=1&rel=0`}
        allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />}
      <div className={styles.transport}>
        <button disabled={position === 0} onClick={() => setPosition((i) => i - 1)}>Previous</button>
        <button disabled={position >= queue.length - 1} onClick={() => setPosition((i) => i + 1)}>Next</button>
      </div>
    </section>}
    <div className={styles.releases}>{releases.map((release) => <section key={release.id} className={styles.release}>
      <div className={styles.releaseHead}>
        {release.art ? <img src={release.art} alt="" /> : <div className={styles.artFallback} aria-hidden="true">♪</div>}
        <div><small>{release.unreleased ? "UNRELEASED" : release.date ? release.date.slice(0, 4) : "DATE UNKNOWN"}</small>
          <h2>{release.name}</h2><p>{release.tracks.length} tracks</p>
          <button onClick={() => play(release, 0)}>▶ Play release</button>
        </div>
      </div>
      <ol>{release.tracks.map((track, index) => <li key={track.id}>
        <button onClick={() => play(release, index)} aria-label={`Play ${track.name}`}>
          <span>{track.disc > 1 ? `${track.disc}.` : ""}{track.number}</span>
          <strong>{track.name}{track.explicit ? " · E" : ""}</strong>
          <small>{track.kind === "audio" ? "Artist audio" : "YouTube"}</small>
          <span>▶</span>
        </button>
      </li>)}</ol>
    </section>)}</div>
    {!releases.length && <p className={styles.empty}>No public recordings are available yet.</p>}
  </main>;
}
