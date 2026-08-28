"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./dashboard.module.css";

/* One screen, four questions: how much, over what stretch of time, who and
   what, and when in the week. Every filter and every click on a bar reloads
   the same payload, so nothing on the page can disagree with anything else. */

type Bucket = "day" | "week" | "month" | "year";
type BucketMode = "auto" | Bucket;
type SourceFilter = "all" | "jukebox" | "spotify";
type Metric = "hours" | "plays";
type Preset = "all" | "30d" | "90d" | "12m" | "ytd" | "custom";

type SeriesRow = { bucket_start: string; events: number; duration_ms: number };
type ArtistRow = { artist: string; events: number; duration_ms: number; tracks?: number };
type TrackRow = { key: string; title: string; artist: string; events: number; duration_ms: number };
type ClockRow = { dow?: number; hour?: number; events: number; duration_ms: number };

export type AnalyticsPayload = {
  tz?: string;
  source?: SourceFilter;
  bucket?: Bucket;
  bounds?: { first_played_at?: string | null; last_played_at?: string | null; events?: number };
  available?: { spotify?: boolean; jukebox?: boolean };
  totals?: {
    events?: number;
    duration_ms?: number;
    artists?: number;
    tracks?: number;
    albums?: number;
    first_played_at?: string | null;
    last_played_at?: string | null;
    skipped?: number;
    spotify_events?: number;
    jukebox_events?: number;
    active_days?: number;
  };
  series?: SeriesRow[];
  topArtists?: ArtistRow[];
  topTracks?: TrackRow[];
  byDow?: ClockRow[];
  byHour?: ClockRow[];
  byHourDow?: ClockRow[];
  artistOptions?: ArtistRow[];
  trackOptions?: TrackRow[];
};

const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRESETS: Array<[Preset, string]> = [
  ["all", "All time"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["12m", "12 months"],
  ["ytd", "This year"],
  ["custom", "Custom"],
];
const BUCKET_MODES: Array<[BucketMode, string]> = [
  ["auto", "Auto"],
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["year", "Year"],
];
// Past this many buckets the bars are thinner than the gap between them, so
// the silent stretches stop being drawn and only real activity is shown.
const MAX_BARS = 1200;
// Long option lists are searched, not scrolled. Rendering all 3,000 artists
// into a popover costs more than it tells anyone.
const MAX_OPTION_ROWS = 200;
// jukebox.listening_analytics joins artist and title with chr(31) to make a
// song key, because two artists share a title often enough to matter.
const TRACK_KEY_SEP = "\u001f";

function count(value: number | undefined) {
  return new Intl.NumberFormat().format(Math.round(value || 0));
}
function hoursOf(ms: number | undefined) {
  return (Number(ms) || 0) / 3_600_000;
}
function fmtHours(ms: number | undefined) {
  const h = hoursOf(ms);
  if (h === 0) return "0";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${count(h)}h`;
}
function fmtMetric(row: { duration_ms?: number; events?: number }, metric: Metric) {
  return metric === "hours" ? fmtHours(row.duration_ms) : count(row.events);
}
function metricValue(row: { duration_ms?: number; events?: number }, metric: Metric) {
  return metric === "hours" ? hoursOf(row.duration_ms) : Number(row.events) || 0;
}
function usDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}
function ymd(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function parseYmd(value: string) {
  return new Date(`${value}T00:00:00Z`);
}
function truncBucket(date: Date, bucket: Bucket) {
  const out = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (bucket === "week") out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
  else if (bucket === "month") out.setUTCDate(1);
  else if (bucket === "year") { out.setUTCMonth(0); out.setUTCDate(1); }
  return out;
}
function stepBucket(date: Date, bucket: Bucket) {
  const out = new Date(date.getTime());
  if (bucket === "day") out.setUTCDate(out.getUTCDate() + 1);
  else if (bucket === "week") out.setUTCDate(out.getUTCDate() + 7);
  else if (bucket === "month") out.setUTCMonth(out.getUTCMonth() + 1);
  else out.setUTCFullYear(out.getUTCFullYear() + 1);
  return out;
}
function bucketLabel(iso: string, bucket: Bucket, spansYears: boolean) {
  const date = parseYmd(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const year = date.getUTCFullYear();
  const month = MONTHS[date.getUTCMonth()];
  if (bucket === "year") return String(year);
  if (bucket === "month") return spansYears ? `${month} '${String(year).slice(2)}` : month;
  const day = `${month} ${date.getUTCDate()}`;
  return spansYears ? `${day}, ${year}` : day;
}
function bucketFullLabel(iso: string, bucket: Bucket) {
  const date = parseYmd(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const long = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  if (bucket === "year") return String(date.getUTCFullYear());
  if (bucket === "month") return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  if (bucket === "week") return `Week of ${long}`;
  return long;
}
function hourLabel(hour: number) {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
function heatColor(t: number) {
  if (t <= 0) return "rgba(255,255,255,.045)";
  const x = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(38 + x * 217)},${Math.round(22 + x * 85)},${Math.round(20 + x * 33)})`;
}

type Option = { key: string; label: string; sub?: string; duration_ms: number; events: number };

function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  metric,
  onToggle,
  onClear,
  onSelectShown,
  note,
}: {
  label: string;
  allLabel: string;
  options: Option[];
  selected: string[];
  metric: Metric;
  onToggle: (key: string) => void;
  onClear: () => void;
  onSelectShown: (keys: string[]) => void;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chosen = useMemo(() => new Set(selected), [selected]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q) || (option.sub || "").toLowerCase().includes(q));
  }, [options, query]);
  const shown = matches.slice(0, MAX_OPTION_ROWS);
  // A selection that scrolled out of the search results still has to be
  // removable, so anything chosen is pinned to the top of the list.
  const pinned = useMemo(() => {
    const inShown = new Set(shown.map((option) => option.key));
    return options.filter((option) => chosen.has(option.key) && !inShown.has(option.key));
  }, [chosen, options, shown]);
  const rows = [...pinned, ...shown];

  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? (options.find((option) => option.key === selected[0])?.label || `1 selected`)
      : `${selected.length} selected`;

  return (
    <div className={styles.msWrap} ref={wrap}>
      <button
        type="button"
        className={`${styles.msBtn} ${selected.length ? styles.msBtnOn : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{summary}</span>
        <em>{open ? "▲" : "▼"}</em>
      </button>
      {open && (
        <div className={styles.msPop}>
          <input
            className={styles.msSearch}
            type="search"
            autoFocus
            value={query}
            placeholder={`Search ${label.toLowerCase()}`}
            aria-label={`Search ${label.toLowerCase()}`}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className={styles.msTools}>
            <span>{count(matches.length)} {matches.length === 1 ? "match" : "matches"}</span>
            <span>
              <button type="button" disabled={!shown.length} onClick={() => onSelectShown(shown.map((option) => option.key))}>Select shown</button>
              {"  ·  "}
              <button type="button" disabled={!selected.length} onClick={onClear}>Clear</button>
            </span>
          </div>
          <div className={styles.msList}>
            {rows.map((option) => (
              <button
                type="button"
                key={option.key}
                className={`${styles.msRow} ${chosen.has(option.key) ? styles.msRowOn : ""}`}
                onClick={() => onToggle(option.key)}
              >
                <i className={styles.msTick}>{chosen.has(option.key) ? "✓" : ""}</i>
                <span className={styles.msName}>
                  {option.label}
                  {option.sub ? <small>{option.sub}</small> : null}
                </span>
                <span className={styles.msVal}>{fmtMetric(option, metric)}</span>
              </button>
            ))}
            {!rows.length && <p className={styles.msNote}>Nothing matches that search.</p>}
          </div>
          {matches.length > shown.length && (
            <p className={styles.msNote}>Showing the top {count(shown.length)} of {count(matches.length)}. Keep typing to narrow it down.</p>
          )}
          {note && <p className={styles.msNote}>{note}</p>}
        </div>
      )}
    </div>
  );
}

type Props = { accessToken: string; onNeedImport: () => void };

export default function AnalyticsDashboard({ accessToken, onNeedImport }: Props) {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [metric, setMetric] = useState<Metric>("hours");
  const [preset, setPreset] = useState<Preset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [artists, setArtists] = useState<string[]>([]);
  const [tracks, setTracks] = useState<string[]>([]);
  const [bucketMode, setBucketMode] = useState<BucketMode>("auto");
  const [hover, setHover] = useState<{ chart: string; index: number } | null>(null);

  // Local calendar days, not instants: the range the picker shows has to be
  // the range the headline reads back.
  const range = useMemo(() => {
    const today = new Date();
    if (preset === "all") return { from: "", to: "" };
    if (preset === "custom") return { from: customFrom, to: customTo };
    if (preset === "ytd") return { from: `${today.getFullYear()}-01-01`, to: ymd(today) };
    const from = new Date(today);
    if (preset === "30d") from.setDate(from.getDate() - 29);
    else if (preset === "90d") from.setDate(from.getDate() - 89);
    else from.setFullYear(from.getFullYear() - 1);
    return { from: ymd(from), to: ymd(today) };
  }, [customFrom, customTo, preset]);

  const requestKey = JSON.stringify({
    source,
    from: range.from,
    to: range.to,
    artists: [...artists].sort(),
    tracks: [...tracks].sort(),
    bucketMode,
  });

  const load = useCallback(async (key: string, signal: AbortSignal) => {
    const query = JSON.parse(key) as {
      source: SourceFilter; from: string; to: string; artists: string[]; tracks: string[]; bucketMode: BucketMode;
    };
    setLoading(true);
    setError("");
    try {
      const toExclusive = query.to ? new Date(`${query.to}T00:00:00`) : null;
      if (toExclusive) toExclusive.setDate(toExclusive.getDate() + 1);
      const response = await fetch("/api/spotify/history", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          action: "analytics",
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
          source: query.source,
          from: query.from ? new Date(`${query.from}T00:00:00`).toISOString() : null,
          to: toExclusive ? toExclusive.toISOString() : null,
          artists: query.artists,
          tracks: query.tracks,
          bucket: query.bucketMode,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || "Could not load your analytics.");
      setData(json.analytics || null);
    } catch (caught) {
      if ((caught as Error)?.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not load your analytics.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    // Ticking four artists in a row is one question, not four.
    const controller = new AbortController();
    const timer = setTimeout(() => void load(requestKey, controller.signal), data ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, load]);

  const totals = data?.totals;
  const available = data?.available || {};
  const bucket: Bucket = (data?.bucket as Bucket) || "month";
  const hasAnyHistory = Number(data?.bounds?.events || 0) > 0;
  const hasRows = Number(totals?.events || 0) > 0;

  const artistOptions = useMemo<Option[]>(
    () => (data?.artistOptions || []).map((row) => ({
      key: row.artist, label: row.artist, duration_ms: row.duration_ms, events: row.events,
    })),
    [data],
  );
  const trackOptions = useMemo<Option[]>(
    () => (data?.trackOptions || []).map((row) => ({
      key: row.key, label: row.title, sub: row.artist, duration_ms: row.duration_ms, events: row.events,
    })),
    [data],
  );
  const trackTitle = useCallback((key: string) => {
    const found = (data?.trackOptions || []).find((row) => row.key === key);
    if (found) return `${found.title} — ${found.artist}`;
    const [artist, title] = key.split(TRACK_KEY_SEP);
    return title ? `${title} — ${artist}` : key;
  }, [data]);

  // Only non-empty buckets come back, so the silent stretches are drawn here.
  const series = useMemo(() => {
    const rows = data?.series || [];
    if (!rows.length) return [] as SeriesRow[];
    const known = new Map(rows.map((row) => [row.bucket_start, row]));
    const first = truncBucket(range.from ? parseYmd(range.from) : parseYmd(rows[0].bucket_start), bucket);
    const lastSource = range.to ? parseYmd(range.to) : parseYmd(rows[rows.length - 1].bucket_start);
    const last = truncBucket(lastSource, bucket);
    const filled: SeriesRow[] = [];
    for (let cursor = first; cursor.getTime() <= last.getTime(); cursor = stepBucket(cursor, bucket)) {
      const key = cursor.toISOString().slice(0, 10);
      filled.push(known.get(key) || { bucket_start: key, events: 0, duration_ms: 0 });
      if (filled.length > MAX_BARS) return rows;
    }
    return filled.length ? filled : rows;
  }, [bucket, data, range.from, range.to]);

  const seriesSpansYears = useMemo(() => {
    if (series.length < 2) return true;
    return series[0].bucket_start.slice(0, 4) !== series[series.length - 1].bucket_start.slice(0, 4);
  }, [series]);
  const seriesMax = Math.max(1, ...series.map((row) => metricValue(row, metric)));
  const axisStep = Math.max(1, Math.ceil(series.length / 12));

  const topArtists = data?.topArtists || [];
  const topTracks = data?.topTracks || [];
  const artistMax = Math.max(1, ...topArtists.map((row) => metricValue(row, metric)));
  const trackMax = Math.max(1, ...topTracks.map((row) => metricValue(row, metric)));

  const dowRows = useMemo(() => {
    const map = new Map((data?.byDow || []).map((row) => [Number(row.dow), row]));
    return DOW_SHORT.map((_, index) => map.get(index) || { dow: index, events: 0, duration_ms: 0 });
  }, [data]);
  const hourRows = useMemo(() => {
    const map = new Map((data?.byHour || []).map((row) => [Number(row.hour), row]));
    return Array.from({ length: 24 }, (_, hour) => map.get(hour) || { hour, events: 0, duration_ms: 0 });
  }, [data]);
  const dowMax = Math.max(1, ...dowRows.map((row) => metricValue(row, metric)));
  const hourMax = Math.max(1, ...hourRows.map((row) => metricValue(row, metric)));
  const heat = useMemo(() => {
    const map = new Map((data?.byHourDow || []).map((row) => [`${row.dow}:${row.hour}`, row]));
    let max = 0;
    map.forEach((row) => { max = Math.max(max, metricValue(row, metric)); });
    return { map, max: Math.max(1, max) };
  }, [data, metric]);

  function toggleArtist(name: string) {
    setArtists((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }
  function toggleTrack(key: string) {
    setTracks((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }
  function clearAll() {
    setSource("all");
    setArtists([]);
    setTracks([]);
    setPreset("all");
    setCustomFrom("");
    setCustomTo("");
    setBucketMode("auto");
  }

  const filterCount = artists.length + tracks.length + (source === "all" ? 0 : 1) + (preset === "all" ? 0 : 1);
  const headHours = count(hoursOf(totals?.duration_ms));
  const readout = hover && hover.chart === "series" ? series[hover.index] : null;

  return (
    <div className={styles.dash}>
      {loading && <span className={styles.busy}>Loading</span>}

      <header className={styles.hero}>
        {hasRows ? (
          <>
            <h1 className={styles.heroTitle}>
              Analyzing <b>{headHours}</b> hours of playback history between{" "}
              <i>{usDate(totals?.first_played_at)}</i> and <i>{usDate(totals?.last_played_at)}</i>
            </h1>
            <ul className={styles.heroSub}>
              <li><b>{count(totals?.events)}</b> plays</li>
              <li><b>{count(totals?.tracks)}</b> songs</li>
              <li><b>{count(totals?.artists)}</b> artists</li>
              <li><b>{count(totals?.albums)}</b> albums</li>
              <li><b>{count(totals?.active_days)}</b> days with music</li>
            </ul>
          </>
        ) : (
          <h1 className={styles.heroTitle}>
            {hasAnyHistory ? "No listening matches these filters" : "Nothing to analyze yet"}
          </h1>
        )}
      </header>

      <div className={styles.toolbar}>
        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Listening platform</span>
          <div className={styles.seg}>
            <button type="button" className={source === "all" ? styles.segOn : ""} onClick={() => setSource("all")}>All</button>
            <button
              type="button"
              className={source === "jukebox" ? styles.segOn : ""}
              disabled={available.jukebox === false}
              onClick={() => setSource("jukebox")}
            >Suffering Jukebox</button>
            <button
              type="button"
              className={source === "spotify" ? styles.segOn : ""}
              disabled={available.spotify === false}
              onClick={() => setSource("spotify")}
            >Spotify</button>
          </div>
        </div>

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Date range</span>
          <div className={styles.seg}>
            {PRESETS.map(([value, label]) => (
              <button key={value} type="button" className={preset === value ? styles.segOn : ""} onClick={() => setPreset(value)}>{label}</button>
            ))}
          </div>
        </div>

        {preset === "custom" && (
          <div className={styles.toolGroup}>
            <span className={styles.toolLabel}>From / to</span>
            <div className={styles.dates}>
              <input type="date" value={customFrom} aria-label="From date" onChange={(event) => setCustomFrom(event.target.value)} />
              <span>to</span>
              <input type="date" value={customTo} aria-label="To date" onChange={(event) => setCustomTo(event.target.value)} />
            </div>
          </div>
        )}

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Artist</span>
          <MultiSelect
            label="artists"
            allLabel="All artists"
            options={artistOptions}
            selected={artists}
            metric={metric}
            onToggle={toggleArtist}
            onClear={() => setArtists([])}
            onSelectShown={(keys) => setArtists((current) => [...new Set([...current, ...keys])])}
          />
        </div>

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Song</span>
          <MultiSelect
            label="songs"
            allLabel="All songs"
            options={trackOptions}
            selected={tracks}
            metric={metric}
            onToggle={toggleTrack}
            onClear={() => setTracks([])}
            onSelectShown={(keys) => setTracks((current) => [...new Set([...current, ...keys])])}
            note="The song list is your most played 1,500. Pick an artist to narrow it."
          />
        </div>

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Measure</span>
          <div className={styles.seg}>
            <button type="button" className={metric === "hours" ? styles.segOn : ""} onClick={() => setMetric("hours")}>Hours</button>
            <button type="button" className={metric === "plays" ? styles.segOn : ""} onClick={() => setMetric("plays")}>Plays</button>
          </div>
        </div>
      </div>

      {filterCount > 0 && (
        <div className={styles.chips}>
          {source !== "all" && (
            <span className={styles.chip}>
              <span>{source === "spotify" ? "Spotify" : "Suffering Jukebox"}</span>
              <button type="button" aria-label="Clear platform filter" onClick={() => setSource("all")}>×</button>
            </span>
          )}
          {preset !== "all" && (
            <span className={styles.chip}>
              <span>{range.from || "start"} → {range.to || "now"}</span>
              <button type="button" aria-label="Clear date filter" onClick={() => { setPreset("all"); setCustomFrom(""); setCustomTo(""); }}>×</button>
            </span>
          )}
          {artists.map((name) => (
            <span className={styles.chip} key={`a:${name}`}>
              <span>{name}</span>
              <button type="button" aria-label={`Remove ${name}`} onClick={() => toggleArtist(name)}>×</button>
            </span>
          ))}
          {tracks.map((key) => (
            <span className={styles.chip} key={`t:${key}`}>
              <span>{trackTitle(key)}</span>
              <button type="button" aria-label="Remove song" onClick={() => toggleTrack(key)}>×</button>
            </span>
          ))}
          <button type="button" className={styles.clearAll} onClick={clearAll}>Clear all filters</button>
        </div>
      )}

      {error && <p className={styles.err}>{error}</p>}

      {!hasRows && !loading ? (
        <div className={styles.cards}>
          <div className={styles.empty}>
            {hasAnyHistory ? (
              <>
                <h2>Nothing in this slice</h2>
                <p>No plays match the platform, dates, artists and songs you have selected.</p>
                <button type="button" className={styles.clearAll} onClick={clearAll}>Clear all filters</button>
              </>
            ) : (
              <>
                <h2>Your listening history is empty</h2>
                <p>Play something in the Jukebox, or bring in your Spotify Extended Streaming History to analyze years of listening at once.</p>
                <button type="button" className={styles.clearAll} onClick={onNeedImport}>Import Spotify history</button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className={`${styles.cards} ${loading ? styles.dimmed : ""}`}>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>{metric === "hours" ? "Listening hours over time" : "Plays over time"}</h2>
              <div className={styles.seg}>
                {BUCKET_MODES.map(([value, label]) => (
                  <button key={value} type="button" className={bucketMode === value ? styles.segOn : ""} onClick={() => setBucketMode(value)}>
                    {value === "auto" ? `Auto (${bucket})` : label}
                  </button>
                ))}
              </div>
            </div>
            <p className={styles.cardNote}>
              {count(series.length)} {bucket}{series.length === 1 ? "" : "s"} from {usDate(totals?.first_played_at)} to {usDate(totals?.last_played_at)}
            </p>
            <p className={styles.readout}>
              {readout
                ? <><b>{bucketFullLabel(readout.bucket_start, bucket)}</b> · {fmtHours(readout.duration_ms)} · {count(readout.events)} plays</>
                : <em>Hover a bar for the exact {bucket}.</em>}
            </p>
            <div className={styles.tsBars} onMouseLeave={() => setHover(null)}>
              {series.map((row, index) => {
                const value = metricValue(row, metric);
                return (
                  <div
                    key={row.bucket_start}
                    className={`${styles.tsBar} ${value ? "" : styles.tsBarZero} ${hover?.chart === "series" && hover.index === index ? styles.tsBarOn : ""}`}
                    title={`${bucketFullLabel(row.bucket_start, bucket)} · ${fmtHours(row.duration_ms)} · ${count(row.events)} plays`}
                    onMouseEnter={() => setHover({ chart: "series", index })}
                  >
                    <i style={{ height: `${Math.max(value > 0 ? 2 : 1, (value / seriesMax) * 100)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className={styles.tsAxis} aria-hidden="true">
              {series.map((row, index) => (
                <span key={row.bucket_start}>{index % axisStep === 0 ? bucketLabel(row.bucket_start, bucket, seriesSpansYears) : ""}</span>
              ))}
            </div>
          </section>

          <div className={styles.pair}>
            <section className={styles.card}>
              <div className={styles.cardHead}><h2>{metric === "hours" ? "Hours by artist" : "Plays by artist"}</h2></div>
              <p className={styles.cardNote}>Top {count(topArtists.length)}. Click one to filter the whole page by it.</p>
              <div className={styles.rank}>
                {topArtists.map((row) => {
                  const on = artists.includes(row.artist);
                  return (
                    <button
                      type="button"
                      key={row.artist}
                      className={`${styles.rankRow} ${on ? styles.rankRowOn : ""}`}
                      aria-pressed={on}
                      onClick={() => toggleArtist(row.artist)}
                    >
                      <span>
                        <span className={styles.rankName}>{row.artist} <small>· {count(row.tracks)} songs</small></span>
                        <span className={styles.rankTrack}><i style={{ width: `${Math.max(2, (metricValue(row, metric) / artistMax) * 100)}%` }} /></span>
                      </span>
                      <span className={styles.rankVal}>{fmtMetric(row, metric)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}><h2>{metric === "hours" ? "Hours by song" : "Plays by song"}</h2></div>
              <p className={styles.cardNote}>Top {count(topTracks.length)}. Click one to filter the whole page by it.</p>
              <div className={styles.rank}>
                {topTracks.map((row) => {
                  const on = tracks.includes(row.key);
                  return (
                    <button
                      type="button"
                      key={row.key}
                      className={`${styles.rankRow} ${on ? styles.rankRowOn : ""}`}
                      aria-pressed={on}
                      onClick={() => toggleTrack(row.key)}
                    >
                      <span>
                        <span className={styles.rankName}>{row.title} <small>· {row.artist}</small></span>
                        <span className={styles.rankTrack}><i style={{ width: `${Math.max(2, (metricValue(row, metric) / trackMax) * 100)}%` }} /></span>
                      </span>
                      <span className={styles.rankVal}>{fmtMetric(row, metric)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          <section className={styles.card}>
            <div className={styles.cardHead}><h2>When you listen</h2></div>
            <p className={styles.cardNote}>Your own clock ({data?.tz || "local time"}).</p>
            <div className={styles.pair}>
              <div>
                <p className={styles.readout}>
                  {hover?.chart === "dow"
                    ? <><b>{DOW_LONG[hover.index]}</b> · {fmtHours(dowRows[hover.index]?.duration_ms)} · {count(dowRows[hover.index]?.events)} plays</>
                    : <em>Day of week</em>}
                </p>
                <div className={styles.miniBars} onMouseLeave={() => setHover(null)}>
                  {dowRows.map((row, index) => (
                    <div
                      key={index}
                      title={`${DOW_LONG[index]} · ${fmtHours(row.duration_ms)} · ${count(row.events)} plays`}
                      onMouseEnter={() => setHover({ chart: "dow", index })}
                    >
                      <i style={{ height: `${Math.max(1, (metricValue(row, metric) / dowMax) * 100)}%` }} />
                    </div>
                  ))}
                </div>
                <div className={styles.miniAxis} aria-hidden="true">
                  {DOW_SHORT.map((label) => <span key={label}>{label}</span>)}
                </div>
              </div>
              <div>
                <p className={styles.readout}>
                  {hover?.chart === "hour"
                    ? <><b>{hourLabel(hover.index)}</b> · {fmtHours(hourRows[hover.index]?.duration_ms)} · {count(hourRows[hover.index]?.events)} plays</>
                    : <em>Time of day</em>}
                </p>
                <div className={styles.miniBars} onMouseLeave={() => setHover(null)}>
                  {hourRows.map((row, index) => (
                    <div
                      key={index}
                      title={`${hourLabel(index)} · ${fmtHours(row.duration_ms)} · ${count(row.events)} plays`}
                      onMouseEnter={() => setHover({ chart: "hour", index })}
                    >
                      <i style={{ height: `${Math.max(1, (metricValue(row, metric) / hourMax) * 100)}%` }} />
                    </div>
                  ))}
                </div>
                <div className={styles.miniAxis} aria-hidden="true">
                  {hourRows.map((_, hour) => <span key={hour}>{hour % 3 === 0 ? hourLabel(hour).replace("m", "") : ""}</span>)}
                </div>
              </div>
            </div>

            <div className={styles.heatWrap}>
              <div className={styles.heat}>
                {DOW_SHORT.map((label, dow) => (
                  <div className={styles.heatRow} key={label}>
                    <b>{label}</b>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const cell = heat.map.get(`${dow}:${hour}`);
                      const value = cell ? metricValue(cell, metric) : 0;
                      return (
                        <i
                          key={hour}
                          style={{ background: heatColor(value / heat.max) }}
                          title={`${DOW_LONG[dow]} ${hourLabel(hour)} · ${fmtHours(cell?.duration_ms)} · ${count(cell?.events)} plays`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className={styles.heatAxis} aria-hidden="true">
                <span />
                {Array.from({ length: 24 }, (_, hour) => <span key={hour}>{hour % 3 === 0 ? hour : ""}</span>)}
              </div>
            </div>
            <div className={styles.heatLegend}>
              <span>Quiet</span>
              {[0, 0.25, 0.5, 0.75, 1].map((stop) => <i key={stop} style={{ background: heatColor(stop) }} />)}
              <span>Busiest</span>
            </div>
          </section>
        </div>
      )}

      <p className={styles.footNote}>
        Hours come from how long each track actually played. A Jukebox play with no measured length falls back to
        the song&apos;s own running time, so the two sources can be added together.
        {Number(totals?.skipped || 0) > 0 && ` ${count(totals?.skipped)} of these plays were skipped early.`}
      </p>
    </div>
  );
}
