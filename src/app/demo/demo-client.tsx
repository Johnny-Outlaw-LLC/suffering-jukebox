"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicSurface } from "@/lib/surface";
import { DEMO_ARTIST, DEMO_ALBUM, DEMO_TRACKS, DEMO_LYRICS, demoTrackKey, demoArtistStats, demoListeningEvents, demoAnalytics } from "@/lib/demo-content";
import { StatsDashboard } from "../artist-stats/stats-dashboard";
import AnalyticsDashboard, { type AnalyticsQuery } from "../analytics/analytics-dashboard";
import shell from "../analytics/analytics.module.css";
import artistStyles from "../artist-stats/artist-stats.module.css";
import DemoImport from "./demo-import";
import styles from "./demo.module.css";

export type DemoView = "artist-stats" | "analytics" | "catalog" | "lyrics" | "history";
const titles: Record<DemoView, string> = { "artist-stats": "Harbor Signal artist stats", analytics: "Your listening, explored", catalog: "A collection you can make your own", lyrics: "The words, in time with the record", history: "From listening history to your collection" };

function Catalog() {
  const [added, setAdded] = useState<Set<string>>(new Set(["Night Drive", "Blue Hour"]));
  return <div className={styles.split}>
    <section className={styles.panel}><div className={styles.cover}>{DEMO_ALBUM}</div><h2>{DEMO_ARTIST}</h2><p>Fictional independent artist · six-song EP · artist audio available for background play and CarPlay.</p>
      {DEMO_TRACKS.slice(0, 6).map((track, index) => <div className={styles.track} key={track.title}><span>{index + 1}</span><div><strong>{track.title}</strong><small>{Math.floor(track.seconds / 60)}:{String(track.seconds % 60).padStart(2, "0")}</small></div><button className={styles.button} aria-pressed={added.has(track.title)} onClick={() => setAdded(current => { const next = new Set(current); if (next.has(track.title)) next.delete(track.title); else next.add(track.title); return next; })}>{added.has(track.title) ? "Added ✓" : "Add to playlist"}</button></div>)}
    </section>
    <section className={styles.panel}><h2>Evening Drive</h2><p>A sample playlist for late roads and city lights. Add or remove a song from the release to see the collection change.</p>{DEMO_TRACKS.filter(track => added.has(track.title)).map(track => <div className={styles.track} key={track.title}><div><strong>{track.title}</strong><small>{track.artist}</small></div><span>{track.artist === DEMO_ARTIST ? "Artist audio" : "Sample source"}</span></div>)}<p className={styles.status} role="status">{added.size} songs in this demo playlist · changes stay in this preview.</p></section>
  </div>;
}

function Lyrics() {
  const [text, setText] = useState(DEMO_TRACKS.slice(0, 2).map(track => `## ${track.title}\n${DEMO_LYRICS.map(line => line.text).join("\n")}`).join("\n\n"));
  const [split, setSplit] = useState(false);
  const [position, setPosition] = useState(0);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setPosition(p => p >= 58 ? 0 : p + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const sections = text.split(/^##\s+/m).map(s => s.trim()).filter(Boolean);
  const active = DEMO_LYRICS.findLastIndex(line => position >= line.t);
  return <div className={styles.split}>
    <section className={styles.panel}><h2>Album lyrics · {DEMO_ALBUM}</h2><p>Try splitting this fictional album text by its song headings. This editable preview does not save lyrics.</p><textarea aria-label="Demo album lyrics" className={styles.textarea} value={text} onChange={e => { setText(e.target.value); setSplit(false); }} /><div className={styles.actions}><button className={`${styles.button} ${styles.primary}`} onClick={() => setSplit(true)}>Split by song</button></div>{split && <div role="status">{sections.map((s, i) => <div className={styles.track} key={i}><div><strong>{s.split("\n")[0]}</strong><small>{s.split("\n").length - 1} lyric lines matched for review</small></div></div>)}</div>}</section>
    <section className={styles.panel}><h2>Sync preview · Night Drive</h2><p>Move through the timeline to see how saved timestamps highlight each line. The timer previews the words; this demo does not play a recording.</p><div className={styles.actions}><button className={styles.button} onClick={() => setRunning(v => !v)}>{running ? "Pause timing preview" : "Start timing preview"}</button><button className={styles.button} onClick={() => { setRunning(false); setPosition(0); }}>Reset</button><span className={styles.status}>0:{String(position).padStart(2, "0")}</span></div><input className={styles.progress} type="range" min={0} max={58} value={position} aria-label="Demo lyric timeline" onChange={e => setPosition(Number(e.target.value))} />{DEMO_LYRICS.map((line, i) => <div key={line.t} className={`${styles.lyric} ${active === i ? styles.lyricActive : ""}`}><time>0:{String(line.t).padStart(2, "0")}</time><span>{line.text}</span></div>)}</section>
  </div>;
}

export default function DemoClient({ view, brand, embedded, preview }: { view: DemoView; brand: PublicSurface; embedded: boolean; preview: boolean }) {
  const [now, setNow] = useState<Date | null>(null);
  const [days, setDays] = useState(30);
  const [imported, setImported] = useState<Set<string>>(new Set());
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const tick = () => {
      const today = new Date();
      setNow(previous => previous?.toDateString() === today.toDateString() ? previous : today);
    };
    tick();
    const timer = setInterval(tick, 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!embedded || window.parent === window || !root.current) return;
    let previous = 0;
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : "";
    if (!parentOrigin) return;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(root.current?.getBoundingClientRect().height || 0);
      if (height === previous || height < 100) return;
      previous = height;
      window.parent.postMessage({ type: "sj:demo-size", height }, parentOrigin);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [embedded]);
  const events = useMemo(() => now ? demoListeningEvents(now) : [], [now]);
  const data = useCallback((query: AnalyticsQuery) => demoAnalytics(query, events, imported), [events, imported]);
  const stats = useMemo(() => now ? demoArtistStats(days, now) : null, [days, now]);
  const query = preview ? "?brand=rk" : "";
  const href = (mode: DemoView) => `/demo/${mode}${query}`;
  const added = (keys: string[]) => setImported(current => new Set([...current, ...keys]));
  const pageStyle = {
    ["--sj-accent" as string]: brand.accent, ["--sj-accent-soft" as string]: `rgba(${brand.accentRgb},.14)`,
    ["--sj-accent-rgb" as string]: brand.accentRgb, ["--sj-accent-hover" as string]: brand.accentHover,
  };
  return <main ref={root} className={`${shell.page} ${styles.page} ${embedded ? styles.embedded : ""}`} data-surface={brand.id} data-demo-brand={preview ? "rk" : brand.id} style={pageStyle}>
    <div className={styles.content}>
      {!embedded && <nav className={styles.nav} aria-label="Demo navigation"><a href={`${brand.url}/for-${view === "artist-stats" || view === "lyrics" ? "artists" : "listeners"}`}>← Back to {brand.name}</a>{(["artist-stats", "analytics", "catalog", "lyrics", "history"] as DemoView[]).map(mode => <a key={mode} href={href(mode)} aria-current={view === mode ? "page" : undefined}>{({ "artist-stats": "Artist stats", analytics: "Listener stats", catalog: "Catalog & playlists", lyrics: "Lyrics", history: "History import" })[mode]}</a>)}</nav>}
      <header className={`${shell.header} ${styles.header}`}><span className={styles.badge}>Interactive demo · fictional content</span><h1>{titles[view]}</h1><p>{brand.name} · Explore the same dashboard controls using a sample artist and listening history. Artists, songs, lyrics, and listening activity are fictional. Dates follow today.</p></header>
      {!now ? <p className={styles.empty}>Preparing the demo…</p> : <>
        {view === "artist-stats" && stats && <><div className={styles.story}><strong>A playlist feature turns discovery into repeat listening.</strong><p>Night Drive leads the EP. Fans return for First Light, heart the chorus, and keep the music playing on their phones and in the car. Change the date range to explore the momentum.</p><div className={styles.storyDates}><span>Artist spotlight · 21 days ago</span><span>Playlist feature · 8 days ago</span><span>Through {now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></div></div><div className={artistStyles.filters} role="group" aria-label="Demo date range">{[[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]].map(([n, label]) => <button key={n} className={`${shell.secondaryButton} ${days === n ? shell.activeTab : ""}`} aria-pressed={days === n} onClick={() => setDays(Number(n))}>{label}</button>)}</div><StatsDashboard stats={stats} brand={brand} /></>}
        {view === "analytics" && <><div className={styles.story}><strong>A new favorite becomes part of the daily routine.</strong><p>The sample listener builds Evening Drive, discovers Harbor Signal, and brings in Spotify and Google history. Compare platforms, select an artist, switch between plays and hours, or try adding a missing song.</p></div><AnalyticsDashboard accessToken="" onNeedImport={() => window.location.assign(href("history"))} demoData={data} demoToday={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`} demoCatalogHref={href("catalog")} renderDemoImport={(songs, selected, onClose) => <DemoImport modal songs={songs} initialSelected={selected} onClose={onClose} onImported={added} />} /></>}
        {view === "catalog" && <Catalog />}
        {view === "lyrics" && <Lyrics />}
        {view === "history" && <DemoImport songs={DEMO_TRACKS.slice(6, 12).map(track => ({ key: demoTrackKey(track), title: track.title, artist: track.artist }))} onImported={added} />}
      </>}
    </div>
  </main>;
}
