"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PublicSurface } from "@/lib/surface";
import shell from "../analytics/analytics.module.css";
import styles from "./artist-stats.module.css";

type StatsArtist = { id: string; name: string; slug: string };
type Day = { day: string; plays: number; listeners: number };
type Song = {
  track_id: string; name: string; album: string; duration_ms: number | null;
  plays: number; listeners: number; listen_ms: number; timed_plays: number; completion: number | null;
  hearts: number; quotes: number; playlist_adds: number;
};
type Moment = {
  track_id: string; name: string; duration_ms: number | null; start_ms: number; n: number; total: number;
  buckets: { s: number; n: number }[]; lyric: string | null;
};
export type Stats = {
  artist: StatsArtist;
  range: { days: number; since: string; tz: string };
  totals: {
    plays: number; listeners: number; returning_listeners: number; listen_ms: number; timed_plays: number;
    prev_plays: number; prev_listeners: number; hearts: number; quotes: number; playlist_adds: number;
    page_visits: number; all_time_plays: number; tracks: number;
  };
  daily: Day[];
  songs: Song[];
  moments: Moment[];
  quotes: { track_id: string; name: string; quote: string; n: number }[];
  contexts: Record<string, number>;
  surfaces: Record<string, number>;
  sources: Record<string, number>;
  places: { top: { city: string; country: string; listeners: number; plays: number }[]; other_listeners: number; unlocated_listeners: number };
  referrers: { source: string; visits: number }[];
  context_since: string | null;
};

const SONGS_SHOWN = 10;
const fmt = new Intl.NumberFormat();
const num = (n: number) => fmt.format(Math.round(n || 0));
const pct = (n: number) => `${Math.round(n * 100)}%`;
function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function hours(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${num(h)} hr ${m % 60} min` : `${num(h)} hr`;
}
function dayLabel(iso: string, withYear = false) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}
/** A clean axis top: 1, 2 or 5 times a power of ten, never below 4. */
function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((k) => k * p).find((c) => c >= v) ?? v;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

// ── Stat tile ────────────────────────────────────────────────────────────────
function Tile({ label, value, note, delta }: { label: string; value: string; note?: string; delta?: { text: string; dir: "up" | "down" | "flat" } }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <strong className={styles.tileValue}>{value}</strong>
      {delta && <em className={`${styles.delta} ${styles[delta.dir]}`}>{delta.dir === "up" ? "▲ " : delta.dir === "down" ? "▼ " : ""}{delta.text}</em>}
      {note && <small className={styles.tileNote}>{note}</small>}
    </div>
  );
}

function deltaFor(cur: number, prev: number, days: number): { text: string; dir: "up" | "down" | "flat" } {
  const span = days === 365 ? "previous year" : `previous ${days} days`;
  if (!prev) return { text: cur ? `up from 0 in the ${span}` : `same as the ${span}`, dir: cur ? "up" : "flat" };
  const change = (cur - prev) / prev;
  if (Math.abs(change) < 0.005) return { text: `same as the ${span}`, dir: "flat" };
  return { text: `${pct(Math.abs(change))} vs the ${span}`, dir: change > 0 ? "up" : "down" };
}

// ── Plays per day: one series, so the title names it and there is no legend ──
function DailyChart({ days }: { days: Day[] }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 210, padL = 34, padR = 14, padT = 14, padB = 28;
  const w = Math.max(width, 280);
  const plotW = w - padL - padR, plotH = H - padT - padB;
  const top = niceMax(Math.max(0, ...days.map((d) => d.plays)));
  const step = days.length > 1 ? plotW / (days.length - 1) : 0;
  const x = (i: number) => padL + (days.length > 1 ? i * step : plotW / 2);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const line = days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.plays).toFixed(1)}`).join("");
  const area = days.length ? `${line}L${x(days.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
  const ticks = [0, top / 2, top];
  const xLabels = days.length > 2 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, i) => i);
  const last = days.length - 1;

  const pick = (clientX: number, rect: DOMRect) => {
    if (!days.length) return;
    const i = Math.round(((clientX - rect.left) - padL) / (step || 1));
    setHover(Math.max(0, Math.min(last, i)));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => pick(e.clientX, e.currentTarget.getBoundingClientRect());
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setHover((h) => Math.max(0, Math.min(last, (h ?? last) + (e.key === "ArrowRight" ? 1 : -1))));
  };
  const hd = hover != null ? days[hover] : null;
  const tipLeft = hover != null ? Math.min(Math.max(x(hover) - 70, 0), w - 140) : 0;

  return (
    <div ref={wrapRef} className={styles.chartWrap}>
      {width > 0 && (
        <svg
          width={w} height={H} role="img" tabIndex={0}
          aria-label={`Plays per day, ${days.length} days. Use the left and right arrow keys to read each day.`}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
          className={styles.chartSvg}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} className={styles.grid} />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" className={styles.axis}>{num(t)}</text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"} className={styles.axis}>
              {dayLabel(days[i].day)}
            </text>
          ))}
          <path d={area} className={styles.area} />
          <path d={line} className={styles.line} />
          {hd && hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} className={styles.crosshair} />}
          {days.length > 0 && (
            <circle cx={x(hover ?? last)} cy={y((hd ?? days[last]).plays)} r={4.5} className={styles.dot} />
          )}
        </svg>
      )}
      {hd && (
        <div className={styles.tooltip} style={{ left: tipLeft }} role="status">
          <span>{dayLabel(hd.day, true)}</span>
          <p><i className={styles.key} /><strong>{num(hd.plays)}</strong> plays</p>
          <p><i className={styles.keyMuted} /><strong>{num(hd.listeners)}</strong> listeners</p>
        </div>
      )}
    </div>
  );
}

// ── One hue for every bar: these are rankings, not separate series ─────────────
type BarRow = { label: string; value: number; detail?: string; muted?: boolean };
function BarList({ rows, unit }: { rows: BarRow[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <ul className={styles.barList}>
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${num(r.value)} ${unit} (${pct(r.value / total)})`}>
          <div className={styles.barText}>
            <span>{r.label}{r.detail ? <small> · {r.detail}</small> : null}</span>
            <strong>{num(r.value)}</strong>
          </div>
          <div className={styles.barTrack}>
            <b className={r.muted ? styles.barMuted : styles.bar} style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Where in a song fans tap the heart ──────────────────────────────────────
function HeartStrip({ m }: { m: Moment }) {
  const dur = Math.max(m.duration_ms || 0, ...m.buckets.map((b) => b.s + 10000));
  const peak = Math.max(1, ...m.buckets.map((b) => b.n));
  return (
    <div className={styles.strip} aria-hidden="true">
      {m.buckets.map((b) => (
        <i
          key={b.s}
          title={`${clock(b.s)}-${clock(b.s + 10000)}: ${b.n} heart${b.n === 1 ? "" : "s"}`}
          className={b.s === m.start_ms ? styles.stripPeak : styles.stripCol}
          style={{ left: `${(b.s / dur) * 100}%`, width: `${(10000 / dur) * 100}%`, height: `${28 + (b.n / peak) * 72}%` }}
        />
      ))}
      <span className={styles.stripStart}>0:00</span>
      <span className={styles.stripEnd}>{clock(dur)}</span>
    </div>
  );
}

const CONTEXT_LABELS: Record<string, string> = {
  native: "iPhone app, screen off or CarPlay",
  app_background: "In the app, screen off",
  app: "In the app",
  web_background: "On the web, screen off",
  web: "On the web",
  unknown: "Not recorded",
};

function contextRows(contexts: Record<string, number>): BarRow[] {
  return Object.keys(CONTEXT_LABELS)
    .filter((k) => contexts[k])
    .map((k) => ({ label: CONTEXT_LABELS[k], value: contexts[k], muted: k === "unknown" }))
    .sort((a, b) => Number(a.muted) - Number(b.muted) || b.value - a.value);
}

/** Everything below the date range: one artist, one range, already loaded. */
export function StatsDashboard({ stats, brand }: { stats: Stats; brand: PublicSurface }) {
  const t = stats.totals;
  // Listen time and screen-off context started with the 2026-10 player update.
  const measuredSince = stats.context_since ? `since ${dayLabel(stats.context_since.slice(0, 10), true)}` : "starting with new plays";
  const rangeDays = stats.range.days;
  const artistUrl = `${brand.url}/${stats.artist.slug}`;
  const songMax = useMemo(() => Math.max(1, ...stats.songs.map((s) => s.plays)), [stats]);
  const [allSongs, setAllSongs] = useState(false);
  const songs = allSongs ? stats.songs : stats.songs.slice(0, SONGS_SHOWN);
  const placeRows: BarRow[] = useMemo(() => {
    const rows: BarRow[] = stats.places.top.map((p) => ({
      label: p.city, detail: p.country === "United States" ? undefined : p.country, value: p.listeners,
    }));
    if (stats.places.other_listeners) rows.push({ label: "Other places", detail: "fewer than 3 listeners each", value: stats.places.other_listeners, muted: true });
    return rows;
  }, [stats]);

  return (
    <>
      <section className={styles.tiles} aria-label="Totals">
        <Tile label="Plays" value={num(t.plays)} delta={deltaFor(t.plays, t.prev_plays, rangeDays)} note={`${num(t.all_time_plays)} all time`} />
        <Tile label="Listeners" value={num(t.listeners)} delta={deltaFor(t.listeners, t.prev_listeners, rangeDays)} />
        <Tile label="Came back" value={num(t.returning_listeners)} note="listened on 2 or more days" />
        <Tile
          label="Time listened"
          value={t.timed_plays ? hours(t.listen_ms) : "-"}
          note={t.timed_plays < t.plays ? `measured ${measuredSince}` : undefined}
        />
        <Tile label="Hearts" value={num(t.hearts)} />
        <Tile label="Playlist adds" value={num(t.playlist_adds)} />
        <Tile label="Page visits" value={num(t.page_visits)} />
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><h2>Plays per day</h2><span>{dayLabel(stats.daily[0]?.day || stats.range.since.slice(0, 10), true)} to today</span></div>
        <DailyChart days={stats.daily} />
        <details className={styles.tableView}>
          <summary>Show as a table</summary>
          <table>
            <thead><tr><th>Day</th><th>Plays</th><th>Listeners</th></tr></thead>
            <tbody>
              {[...stats.daily].reverse().map((d) => <tr key={d.day}><td>{dayLabel(d.day, true)}</td><td>{num(d.plays)}</td><td>{num(d.listeners)}</td></tr>)}
            </tbody>
          </table>
        </details>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}><h2>Songs</h2><span>{num(t.tracks)} songs</span></div>
        <div className={styles.tableScroll}>
          <table className={styles.songs}>
            <thead>
              <tr>
                <th scope="col">Song</th>
                <th scope="col" className={styles.playsCol}>Plays</th>
                <th scope="col">Listeners</th>
                <th scope="col" title="Average share of the song heard, from plays that measured it">Heard</th>
                <th scope="col">Hearts</th>
                <th scope="col">Quotes</th>
                <th scope="col">Playlists</th>
              </tr>
            </thead>
            <tbody>
              {songs.map((s) => (
                <tr key={s.track_id}>
                  <th scope="row"><span>{s.name}</span><small>{s.album}</small></th>
                  <td className={styles.playsCol}>
                    <div className={styles.inlineBar}>
                      <b style={{ width: `${(s.plays / songMax) * 100}%` }} />
                      <span>{num(s.plays)}</span>
                    </div>
                  </td>
                  <td>{num(s.listeners)}</td>
                  <td title={s.timed_plays ? `from ${num(s.timed_plays)} measured plays` : "Not measured yet"}>{s.completion != null ? pct(s.completion) : "-"}</td>
                  <td>{num(s.hearts)}</td>
                  <td>{num(s.quotes)}</td>
                  <td>{num(s.playlist_adds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {stats.songs.length > SONGS_SHOWN && (
          <button type="button" className={styles.moreButton} onClick={() => setAllSongs((v) => !v)}>
            {allSongs ? `Show the top ${SONGS_SHOWN}` : `Show all ${num(stats.songs.length)} songs`}
          </button>
        )}
      </section>

      <div className={styles.grid2}>
        <section className={styles.panel}>
          <div className={styles.panelHead}><h2>Heart moments</h2><span>where fans tap ♥ mid-song</span></div>
          {stats.moments.length ? (
            <ol className={styles.moments}>
              {stats.moments.map((m) => (
                <li key={m.track_id}>
                  <div className={styles.momentHead}>
                    <strong>{m.name}</strong>
                    <span>{clock(m.start_ms)}-{clock(m.start_ms + 10000)} · {num(m.n)} of {num(m.total)} heart{m.total === 1 ? "" : "s"}</span>
                  </div>
                  {m.lyric && <blockquote>&ldquo;{m.lyric}&rdquo;</blockquote>}
                  <HeartStrip m={m} />
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>When fans tap the heart while a song plays, the moment shows up here, with the lyric they were hearing.</p>
          )}
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><h2>Most-quoted lyrics</h2><span>lines fans reacted to</span></div>
          {stats.quotes.length ? (
            <ol className={styles.quotes}>
              {stats.quotes.map((q) => (
                <li key={`${q.track_id}:${q.quote}`}>
                  <blockquote>&ldquo;{q.quote}&rdquo;</blockquote>
                  <span>{q.name} · {num(q.n)} reaction{q.n === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>Fans can react to a single line while the lyrics scroll. The lines they pick land here. Synced lyrics make this work.</p>
          )}
        </section>
      </div>

      <div className={styles.grid3}>
        <section className={styles.panel}>
          <div className={styles.panelHead}><h2>How they listen</h2><span>plays</span></div>
          <BarList rows={contextRows(stats.contexts)} unit="plays" />
          {stats.contexts.unknown ? <p className={styles.footnote}>Web and in-app listening is recorded {measuredSince}. The iPhone lock screen and CarPlay were already recorded.</p> : null}
          <h3 className={styles.subhead}>Format</h3>
          <BarList
            rows={[
              { label: "Uploaded audio", value: stats.sources.audio || 0 },
              { label: "YouTube video", value: stats.sources.video || 0 },
            ].filter((r) => r.value)}
            unit="plays"
          />
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><h2>Where they are</h2><span>listeners</span></div>
          {placeRows.length ? <BarList rows={placeRows} unit="listeners" /> : <p className={styles.empty}>Cities appear once three or more listeners share one.</p>}
          {stats.places.unlocated_listeners ? <p className={styles.footnote}>{num(stats.places.unlocated_listeners)} listener{stats.places.unlocated_listeners === 1 ? "" : "s"} could not be placed. Cities with fewer than three listeners are grouped so no single fan stands out.</p> : null}
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHead}><h2>How they found you</h2><span>visits to your page</span></div>
          {stats.referrers.length
            ? <BarList rows={stats.referrers.map((r) => ({ label: r.source, value: r.visits, muted: r.source === "Direct link or typed in" }))} unit="visits" />
            : <p className={styles.empty}>Share your page link and the sites that send fans show up here.</p>}
          <p className={styles.footnote}>Counts visits to {artistUrl.replace(/^https?:\/\//, "")}. Plays started inside {brand.name} are in the totals above.</p>
        </section>
      </div>
    </>
  );
}
