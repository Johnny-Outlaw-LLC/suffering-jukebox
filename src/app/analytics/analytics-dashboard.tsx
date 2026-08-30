"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./dashboard.module.css";
import ImportMissing, { type MissingSong } from "./import-missing";

/* One screen. Everything answers to the same filter rail, and every measure is
   split by where the listen came from, so Suffering Jukebox and Spotify are
   two colours in the same bar rather than one indistinguishable total. */

type Bucket = "day" | "week" | "month" | "year";
type BucketMode = "auto" | Bucket;
type SourceFilter = "all" | "jukebox" | "spotify";
type Metric = "hours" | "plays";
type Preset = "all" | "30d" | "90d" | "12m" | "24m" | "ytd" | "custom";

/* A picker starts with everything ticked, so the common shape is "all but
   these four". Saying that as an include list would mean shipping 2,752 names,
   hence the third mode. "all" is the same as an empty filter. */
type Selection = { mode: "all" } | { mode: "none" } | { mode: "include" | "exclude"; keys: string[] };

type Split = { duration_ms: number; events: number; spotify_ms: number; jukebox_ms: number; spotify_events: number; jukebox_events: number };
type SeriesRow = Split & { bucket_start: string };
type CalendarRow = Split & { day: string };
type ArtistRow = Split & { artist: string; tracks?: number; in_jukebox?: boolean };
type TrackRow = Split & { key: string; title: string; artist: string; in_jukebox?: boolean };
type HeatRow = Split & { dow: number; hour: number };
type OptionRow = { artist: string; key?: string; title?: string; events: number; duration_ms: number };

export type AnalyticsPayload = {
  tz?: string;
  source?: SourceFilter;
  bucket?: Bucket;
  bounds?: { first_played_at?: string | null; last_played_at?: string | null; events?: number };
  available?: { spotify?: boolean; jukebox?: boolean };
  totals?: Partial<Split> & {
    artists?: number;
    tracks?: number;
    albums?: number;
    first_played_at?: string | null;
    last_played_at?: string | null;
    skipped?: number;
    active_days?: number;
  };
  series?: SeriesRow[];
  calendar?: CalendarRow[];
  topArtists?: ArtistRow[];
  topTracks?: TrackRow[];
  byHourDow?: HeatRow[];
  artistOptions?: OptionRow[];
  trackOptions?: OptionRow[];
};

const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRESETS: Array<[Preset, string]> = [
  ["all", "All time"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["12m", "12 months"],
  ["24m", "Last 2 years"],
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
// Long option lists are searched, not scrolled.
const MAX_OPTION_ROWS = 200;
// jukebox.listening_analytics joins artist and title with chr(31) to make a
// song key, because two artists share a title often enough to matter.
const TRACK_KEY_SEP = "";
const JUKEBOX_RGB = [255, 107, 53];
const SPOTIFY_RGB = [29, 185, 84];

const ALL: Selection = { mode: "all" };

function selShows(sel: Selection, key: string) {
  if (sel.mode === "all") return true;
  if (sel.mode === "none") return false;
  const listed = sel.keys.includes(key);
  return sel.mode === "include" ? listed : !listed;
}
/* Everything ticked is no filter at all, whatever the option list was capped
   at. That is what keeps the truncated song list honest: unticking one song
   yields an exclude of one, which applies to every song, not just the 1,500
   the picker could show. */
function normalizeSelection(checked: Set<string>, allKeys: string[]): Selection {
  if (checked.size === 0 && allKeys.length) return { mode: "none" };
  if (checked.size >= allKeys.length) return ALL;
  const unchecked = allKeys.filter((key) => !checked.has(key));
  return unchecked.length < checked.size
    ? { mode: "exclude", keys: unchecked }
    : { mode: "include", keys: [...checked] };
}
/* Clicking a bar means "focus on this one", and clicking a second means "and
   this one too" - which is only possible because the rankings deliberately do
   not apply their own filter. */
function selectionAfterBarClick(sel: Selection, key: string): Selection {
  if (sel.mode === "all") return { mode: "include", keys: [key] };
  if (sel.mode === "none") return { mode: "include", keys: [key] };
  if (sel.mode === "exclude") {
    const kept = sel.keys.filter((item) => item !== key);
    // Clicking something the picker had hidden puts it back.
    if (kept.length !== sel.keys.length) return kept.length ? { mode: "exclude", keys: kept } : ALL;
    return { mode: "include", keys: [key] };
  }
  const keys = sel.keys.includes(key) ? sel.keys.filter((item) => item !== key) : [...sel.keys, key];
  return keys.length ? { mode: "include", keys } : ALL;
}

function count(value: number | undefined) {
  return new Intl.NumberFormat().format(Math.round(value || 0));
}
function hoursOf(ms: number | undefined) {
  return (Number(ms) || 0) / 3_600_000;
}
function fmtHours(ms: number | undefined) {
  const hours = hoursOf(ms);
  if (hours === 0) return "0";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${count(hours)}h`;
}
function metricValue(row: Partial<Split> | undefined, metric: Metric) {
  if (!row) return 0;
  return metric === "hours" ? hoursOf(row.duration_ms) : Number(row.events) || 0;
}
function metricParts(row: Partial<Split> | undefined, metric: Metric) {
  if (!row) return { jukebox: 0, spotify: 0 };
  return metric === "hours"
    ? { jukebox: hoursOf(row.jukebox_ms), spotify: hoursOf(row.spotify_ms) }
    : { jukebox: Number(row.jukebox_events) || 0, spotify: Number(row.spotify_events) || 0 };
}
function fmtMetric(row: Partial<Split> | undefined, metric: Metric) {
  return metric === "hours" ? fmtHours(row?.duration_ms) : count(row?.events);
}
function describe(row: Partial<Split> | undefined) {
  const jukebox = Number(row?.jukebox_ms) || 0;
  const spotify = Number(row?.spotify_ms) || 0;
  const both = jukebox > 0 && spotify > 0;
  const total = `${fmtHours(row?.duration_ms)} · ${count(row?.events)} plays`;
  return both ? `${total} (Jukebox ${fmtHours(jukebox)}, Spotify ${fmtHours(spotify)})` : total;
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
/* A cell's hue says which source it mostly came from; its brightness says how
   much listening it holds. */
function heatColor(row: Partial<Split> | undefined, intensity: number) {
  const level = Math.max(0, Math.min(1, intensity));
  if (level <= 0) return "rgba(255,255,255,.045)";
  const jukebox = Number(row?.jukebox_ms) || 0;
  const spotify = Number(row?.spotify_ms) || 0;
  const share = jukebox + spotify > 0 ? spotify / (jukebox + spotify) : 0;
  const channels = JUKEBOX_RGB.map((value, index) => value + (SPOTIFY_RGB[index] - value) * share);
  return `rgb(${channels.map((value) => Math.round(16 + (value - 16) * (0.22 + 0.78 * level))).join(",")})`;
}
function sourceHeatColor(rgb: number[], intensity: number) {
  const level = Math.max(0, Math.min(1, intensity));
  if (level <= 0) return "rgba(255,255,255,.045)";
  return `rgb(${rgb.map((value) => Math.round(16 + (value - 16) * (0.22 + 0.78 * level))).join(",")})`;
}
function importHref(artist: string, title?: string) {
  const params = new URLSearchParams();
  params.set("import", title ? "song" : "artist");
  params.set("artist", artist);
  if (title) params.set("title", title);
  return `/?${params.toString()}`;
}

type Option = { key: string; label: string; sub?: string; duration_ms: number; events: number };

function MultiSelect({
  noun,
  allLabel,
  options,
  selection,
  metric,
  onApply,
  note,
}: {
  noun: string;
  allLabel: string;
  options: Option[];
  selection: Selection;
  metric: Metric;
  onApply: (next: Selection) => void;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const wrap = useRef<HTMLDivElement | null>(null);

  const allKeys = useMemo(() => options.map((option) => option.key), [options]);

  // The popover holds a draft until Apply, so ticking six boxes is one request.
  const openPicker = useCallback(() => {
    setDraft(new Set(allKeys.filter((key) => selShows(selection, key))));
    setQuery("");
    setOpen(true);
  }, [allKeys, selection]);

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

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle) || (option.sub || "").toLowerCase().includes(needle));
  }, [options, query]);
  const shown = matches.slice(0, MAX_OPTION_ROWS);

  const label = selection.mode === "all"
    ? allLabel
    : selection.mode === "none"
      ? `No ${noun}`
    : selection.mode === "exclude"
      ? `All but ${count(selection.keys.length)} ${noun}`
      : selection.keys.length === 1
        ? (options.find((option) => option.key === selection.keys[0])?.label || `1 ${noun.replace(/s$/, "")}`)
        : `${count(selection.keys.length)} of ${count(options.length)} ${noun}`;

  return (
    <div className={styles.msWrap} ref={wrap}>
      <button
        type="button"
        className={`${styles.msBtn} ${selection.mode === "all" ? "" : styles.msBtnOn}`}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <span>{label}</span>
        <em>{open ? "▲" : "▼"}</em>
      </button>
      {open && (
        <div className={styles.msPop}>
          <input
            className={styles.msSearch}
            type="search"
            autoFocus
            value={query}
            placeholder={`Search ${noun}`}
            aria-label={`Search ${noun}`}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className={styles.msTools}>
            <span>{count(matches.length)} {matches.length === 1 ? "match" : "matches"}</span>
            <span>
              <button type="button" onClick={() => setDraft(new Set(allKeys))}>Select all</button>
              {"  ·  "}
              <button type="button" onClick={() => setDraft(new Set())}>Clear all</button>
            </span>
          </div>
          <div className={styles.msList}>
            {shown.map((option) => {
              const ticked = draft.has(option.key);
              return (
                <button
                  type="button"
                  key={option.key}
                  className={`${styles.msRow} ${ticked ? styles.msRowOn : ""}`}
                  onClick={() => setDraft((current) => {
                    const next = new Set(current);
                    if (next.has(option.key)) next.delete(option.key);
                    else next.add(option.key);
                    return next;
                  })}
                >
                  <i className={styles.msTick}>{ticked ? "✓" : ""}</i>
                  <span className={styles.msName}>
                    {option.label}
                    {option.sub ? <small>{option.sub}</small> : null}
                  </span>
                  <span className={styles.msVal}>{fmtMetric(option as unknown as Split, metric)}</span>
                </button>
              );
            })}
            {!shown.length && <p className={styles.msNote}>Nothing matches that search.</p>}
          </div>
          {matches.length > shown.length && (
            <p className={styles.msNote}>Showing the first {count(shown.length)} of {count(matches.length)}. Keep typing to narrow it down.</p>
          )}
          {note && <p className={styles.msNote}>{note}</p>}
          <div className={styles.msFoot}>
            <span>{count(draft.size)} of {count(options.length)} ticked</span>
            <button type="button" className={styles.msCancel} onClick={() => setOpen(false)}>Cancel</button>
            <button
              type="button"
              className={styles.msApply}
              onClick={() => { onApply(normalizeSelection(draft, allKeys)); setOpen(false); }}
            >Apply</button>
          </div>
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
  const [preset, setPreset] = useState<Preset>("24m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [artistSel, setArtistSel] = useState<Selection>(ALL);
  const [trackSel, setTrackSel] = useState<Selection>(ALL);
  const [bucketMode, setBucketMode] = useState<BucketMode>("auto");
  const [hover, setHover] = useState<number | null>(null);
  const [calendarYear, setCalendarYear] = useState<number | null>(null);
  // The keys the import panel opens with, or null when it is closed. An empty
  // array is still open - that is "the whole missing list, nothing ticked".
  const [importing, setImporting] = useState<string[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

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
    else from.setFullYear(from.getFullYear() - (preset === "24m" ? 2 : 1));
    return { from: ymd(from), to: ymd(today) };
  }, [customFrom, customTo, preset]);

  const requestKey = JSON.stringify({ source, from: range.from, to: range.to, artistSel, trackSel, bucketMode });

  const load = useCallback(async (key: string, signal: AbortSignal) => {
    const query = JSON.parse(key) as {
      source: SourceFilter; from: string; to: string; artistSel: Selection; trackSel: Selection; bucketMode: BucketMode;
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
          artists: query.artistSel.mode === "all" ? null : query.artistSel.mode === "none" ? [] : query.artistSel.keys,
          artistsMode: query.artistSel.mode === "all" ? "include" : query.artistSel.mode,
          tracks: query.trackSel.mode === "all" ? null : query.trackSel.mode === "none" ? [] : query.trackSel.keys,
          tracksMode: query.trackSel.mode === "all" ? "include" : query.trackSel.mode,
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
    // Clicking three artist bars in a row is one question, not three.
    const controller = new AbortController();
    const timer = setTimeout(() => void load(requestKey, controller.signal), data ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, load, reloadTick]);

  const totals = data?.totals;
  const available = data?.available || {};
  const bucket: Bucket = (data?.bucket as Bucket) || "month";
  const hasAnyHistory = Number(data?.bounds?.events || 0) > 0;
  const hasRows = Number(totals?.events || 0) > 0;
  const bothSources = Number(totals?.jukebox_ms || 0) > 0 && Number(totals?.spotify_ms || 0) > 0;

  const artistOptions = useMemo<Option[]>(
    () => (data?.artistOptions || []).map((row) => ({
      key: row.artist, label: row.artist, duration_ms: row.duration_ms, events: row.events,
    })),
    [data],
  );
  const trackOptions = useMemo<Option[]>(
    () => (data?.trackOptions || []).map((row) => ({
      key: row.key || "", label: row.title || "", sub: row.artist, duration_ms: row.duration_ms, events: row.events,
    })),
    [data],
  );

  // Only non-empty buckets come back, so the silent stretches are drawn here.
  const series = useMemo(() => {
    const rows = data?.series || [];
    if (!rows.length) return [] as SeriesRow[];
    const known = new Map(rows.map((row) => [row.bucket_start, row]));
    const first = truncBucket(range.from ? parseYmd(range.from) : parseYmd(rows[0].bucket_start), bucket);
    const last = truncBucket(range.to ? parseYmd(range.to) : parseYmd(rows[rows.length - 1].bucket_start), bucket);
    const filled: SeriesRow[] = [];
    for (let cursor = first; cursor.getTime() <= last.getTime(); cursor = stepBucket(cursor, bucket)) {
      const key = cursor.toISOString().slice(0, 10);
      filled.push(known.get(key) || {
        bucket_start: key, events: 0, duration_ms: 0, spotify_ms: 0, jukebox_ms: 0, spotify_events: 0, jukebox_events: 0,
      });
      if (filled.length > MAX_BARS) return rows;
    }
    return filled.length ? filled : rows;
  }, [bucket, data, range.from, range.to]);

  const seriesSpansYears = series.length < 2 || series[0].bucket_start.slice(0, 4) !== series[series.length - 1].bucket_start.slice(0, 4);
  const seriesMax = Math.max(1, ...series.map((row) => metricValue(row, metric)));
  const axisStep = Math.max(1, Math.ceil(series.length / 12));

  const topArtists = data?.topArtists || [];
  const topTracks = data?.topTracks || [];
  const artistMax = Math.max(1, ...topArtists.map((row) => metricValue(row, metric)));
  const trackMax = Math.max(1, ...topTracks.map((row) => metricValue(row, metric)));

  /* Everything on this chart the catalogue does not have yet, in the order the
     chart already put them - so the panel opens on the songs you play most,
     not on an alphabet. Filters carry through, because the missing list is
     drawn from the same rows as the bars above it. */
  const missingSongs: MissingSong[] = useMemo(
    () => (data?.topTracks || [])
      .filter((row) => row.in_jukebox === false)
      .map((row) => ({ key: row.key, title: row.title, artist: row.artist })),
    [data],
  );

  const heat = useMemo(() => {
    const map = new Map((data?.byHourDow || []).map((row) => [`${row.dow}:${row.hour}`, row]));
    let max = 0;
    map.forEach((row) => { max = Math.max(max, metricValue(row, metric)); });
    return { map, max: Math.max(1, max) };
  }, [data, metric]);
  const heatSources = useMemo(() => {
    const sourceValue = (row: HeatRow | undefined, key: "jukebox" | "spotify") => Number(metric === "hours" ? row?.[`${key}_ms`] : row?.[`${key}_events`]) || 0;
    return ([
      { key: "jukebox" as const, label: "Suffering Jukebox", rgb: JUKEBOX_RGB },
      { key: "spotify" as const, label: "Spotify", rgb: SPOTIFY_RGB },
    ]).filter((item) => source === "all" || source === item.key).map((item) => ({
      ...item,
      max: Math.max(1, ...(data?.byHourDow || []).map((row) => sourceValue(row, item.key))),
      value: (row: HeatRow | undefined) => sourceValue(row, item.key),
    })).filter((item) => (data?.byHourDow || []).some((row) => item.value(row) > 0));
  }, [data, metric, source]);

  const calendarDays = useMemo(() => new Map((data?.calendar || []).map((row) => [row.day, row])), [data]);
  const calendarYears = useMemo(() => {
    const years = new Set<number>();
    (data?.calendar || []).forEach((row) => years.add(Number(row.day.slice(0, 4))));
    return [...years].sort((a, b) => b - a);
  }, [data]);
  useEffect(() => {
    if (!calendarYears.length) return;
    setCalendarYear((current) => (current && calendarYears.includes(current) ? current : calendarYears[0]));
  }, [calendarYears]);

  // A GitHub-style year: one column per week, Sunday at the top.
  const calendar = useMemo(() => {
    const year = calendarYear || calendarYears[0];
    if (!year) return { weeks: [] as Array<Array<CalendarRow | null>>, max: 1 };
    const cells: Array<CalendarRow | null> = [];
    const start = new Date(Date.UTC(year, 0, 1));
    for (let pad = 0; pad < start.getUTCDay(); pad += 1) cells.push(null);
    let max = 0;
    for (let cursor = start; cursor.getUTCFullYear() === year; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const key = cursor.toISOString().slice(0, 10);
      const row = calendarDays.get(key) || null;
      if (row) max = Math.max(max, metricValue(row, metric));
      cells.push(row || { day: key, events: 0, duration_ms: 0, spotify_ms: 0, jukebox_ms: 0, spotify_events: 0, jukebox_events: 0 });
    }
    const weeks: Array<Array<CalendarRow | null>> = [];
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
    return { weeks, max: Math.max(1, max) };
  }, [calendarDays, calendarYear, calendarYears, metric]);

  function clearAll() {
    setSource("all");
    setArtistSel(ALL);
    setTrackSel(ALL);
    setPreset("all");
    setCustomFrom("");
    setCustomTo("");
    setBucketMode("auto");
  }
  const anyFilter = source !== "all" || preset !== "all" || artistSel.mode !== "all" || trackSel.mode !== "all";
  const readout = hover === null ? null : series[hover];

  function rankRows<T extends Split & { in_jukebox?: boolean }>(
    rows: T[],
    max: number,
    keyOf: (row: T) => string,
    nameOf: (row: T) => React.ReactNode,
    selection: Selection,
    onClick: (key: string) => void,
    actionOf: (row: T) => React.ReactNode,
  ) {
    return rows.map((row) => {
      const key = keyOf(row);
      const on = selection.mode !== "all" && selection.mode === "include" && selection.keys.includes(key);
      const parts = metricParts(row, metric);
      const total = Math.max(parts.jukebox + parts.spotify, metricValue(row, metric));
      return (
        <div className={`${styles.rankRow} ${on ? styles.rankRowOn : ""}`} key={key}>
          <button type="button" className={styles.rankHit} aria-pressed={on} title={describe(row)} onClick={() => onClick(key)}>
            <span className={styles.rankName}>{nameOf(row)}</span>
            <span className={styles.rankTrack}>
              <i className={styles.segJukebox} style={{ width: `${(parts.jukebox / max) * 100}%` }} />
              <i className={styles.segSpotify} style={{ width: `${(parts.spotify / max) * 100}%` }} />
              {total === 0 && <i style={{ width: "2px", background: "#333" }} />}
            </span>
          </button>
          <span className={styles.rankVal}>{fmtMetric(row, metric)}</span>
          {row.in_jukebox === false ? actionOf(row) : <span />}
        </div>
      );
    });
  }

  return (
    <div className={styles.dash}>
      {loading && <span className={styles.busy}>Loading</span>}

      <header className={styles.hero}>
        {hasRows ? (
          <>
            <h1 className={styles.heroTitle}>
              Analyzing <b>{count(hoursOf(totals?.duration_ms))}</b> hours of playback history between{" "}
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
        {available.spotify && (
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
                onClick={() => setSource("spotify")}
              >Spotify</button>
            </div>
          </div>
        )}

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
            noun="artists"
            allLabel="All artists"
            options={artistOptions}
            selection={artistSel}
            metric={metric}
            onApply={setArtistSel}
          />
        </div>

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Song</span>
          <MultiSelect
            noun="songs"
            allLabel="All songs"
            options={trackOptions}
            selection={trackSel}
            metric={metric}
            onApply={setTrackSel}
            note="The list holds your 1,500 most played. Unticking works on all of them; ticking only works on what is listed."
          />
        </div>

        <div className={styles.toolGroup}>
          <span className={styles.toolLabel}>Measure</span>
          <div className={styles.seg}>
            <button type="button" className={metric === "hours" ? styles.segOn : ""} onClick={() => setMetric("hours")}>Hours</button>
            <button type="button" className={metric === "plays" ? styles.segOn : ""} onClick={() => setMetric("plays")}>Plays</button>
          </div>
        </div>

        {anyFilter && (
          <div className={styles.toolGroup}>
            <span className={styles.toolLabel}>&nbsp;</span>
            <button type="button" className={styles.resetBtn} onClick={clearAll}>Clear all filters</button>
          </div>
        )}
      </div>

      {hasRows && (
        <div className={styles.legend}>
          {Number(totals?.jukebox_ms || 0) > 0 && (
            <span><i className={styles.swJukebox} /> Suffering Jukebox <b>{fmtHours(totals?.jukebox_ms)}</b> · {count(totals?.jukebox_events)} plays</span>
          )}
          {Number(totals?.spotify_ms || 0) > 0 && (
            <span><i className={styles.swSpotify} /> Spotify <b>{fmtHours(totals?.spotify_ms)}</b> · {count(totals?.spotify_events)} plays</span>
          )}
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
                <button type="button" className={styles.resetBtn} onClick={clearAll}>Clear all filters</button>
              </>
            ) : (
              <>
                <h2>Your listening history is empty</h2>
                <p>Play something in the Jukebox, or bring in your Spotify Extended Streaming History to analyze years of listening at once.</p>
                <button type="button" className={styles.resetBtn} onClick={onNeedImport}>Import Spotify history</button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className={`${styles.cards} ${loading ? styles.dimmed : ""}`}>
          <div className={styles.pair}>
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
              <p className={styles.readout}>{readout ? <><b>{bucketFullLabel(readout.bucket_start, bucket)}</b> · {describe(readout)}</> : <em>{count(series.length)} {bucket}{series.length === 1 ? "" : "s"} · hover a bar for the exact {bucket}.</em>}</p>
              <div className={styles.tsBars} onMouseLeave={() => setHover(null)}>
                {series.map((row, index) => {
                  const value = metricValue(row, metric); const parts = metricParts(row, metric); const sum = parts.jukebox + parts.spotify || 1;
                  return <div key={row.bucket_start} className={`${styles.tsBar} ${value ? "" : styles.tsBarZero} ${hover === index ? styles.tsBarOn : ""}`} title={`${bucketFullLabel(row.bucket_start, bucket)} · ${describe(row)}`} onMouseEnter={() => setHover(index)}><i style={{ height: `${Math.max(value > 0 ? 2 : 1, (value / seriesMax) * 100)}%` }}><b className={styles.segJukebox} style={{ height: `${(parts.jukebox / sum) * 100}%` }} /><b className={styles.segSpotify} style={{ height: `${(parts.spotify / sum) * 100}%` }} /></i></div>;
                })}
              </div>
              <div className={styles.tsAxis} aria-hidden="true">{series.map((row, index) => <span key={row.bucket_start}>{index % axisStep === 0 ? bucketLabel(row.bucket_start, bucket, seriesSpansYears) : ""}</span>)}</div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}><h2>Day of week and time of day</h2></div>
              <p className={styles.cardNote}>Your own clock ({data?.tz || "local time"}).</p>
              <div className={`${styles.sourceHeats} ${heatSources.length === 1 ? styles.sourceHeatsOne : ""}`}>
                {heatSources.map((item) => (
                  <div className={styles.sourceHeat} key={item.key}>
                    <div className={styles.sourceHeatTitle}><i style={{ background: `rgb(${item.rgb.join(",")})` }} />{item.label}</div>
                    <div className={styles.heat}>
                      {DOW_SHORT.map((label, dow) => (
                        <div className={styles.heatRow} key={label}>
                          <b>{label}</b>
                          {Array.from({ length: 24 }, (_, hour) => {
                            const cell = heat.map.get(`${dow}:${hour}`);
                            const value = item.value(cell);
                            return <i key={hour} style={{ background: sourceHeatColor(item.rgb, value / item.max) }} title={`${item.label} · ${DOW_LONG[dow]} ${hourLabel(hour)} · ${metric === "hours" ? fmtHours(value * 3_600_000) : `${count(value)} plays`}`} />;
                          })}
                        </div>
                      ))}
                    </div>
                    <div className={styles.heatAxis} aria-hidden="true"><span />{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{hour % 3 === 0 ? hour : ""}</span>)}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {false && <section className={styles.card}>
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
            <p className={styles.readout}>
              {readout
                ? <><b>{bucketFullLabel(readout!.bucket_start, bucket)}</b> · {describe(readout!)}</>
                : <em>{count(series.length)} {bucket}{series.length === 1 ? "" : "s"} · hover a bar for the exact {bucket}.</em>}
            </p>
            <div className={styles.tsBars} onMouseLeave={() => setHover(null)}>
              {series.map((row, index) => {
                const value = metricValue(row, metric);
                const parts = metricParts(row, metric);
                const sum = parts.jukebox + parts.spotify || 1;
                return (
                  <div
                    key={row.bucket_start}
                    className={`${styles.tsBar} ${value ? "" : styles.tsBarZero} ${hover === index ? styles.tsBarOn : ""}`}
                    title={`${bucketFullLabel(row.bucket_start, bucket)} · ${describe(row)}`}
                    onMouseEnter={() => setHover(index)}
                  >
                    <i style={{ height: `${Math.max(value > 0 ? 2 : 1, (value / seriesMax) * 100)}%` }}>
                      <b className={styles.segJukebox} style={{ height: `${(parts.jukebox / sum) * 100}%` }} />
                      <b className={styles.segSpotify} style={{ height: `${(parts.spotify / sum) * 100}%` }} />
                    </i>
                  </div>
                );
              })}
            </div>
            <div className={styles.tsAxis} aria-hidden="true">
              {series.map((row, index) => (
                <span key={row.bucket_start}>{index % axisStep === 0 ? bucketLabel(row.bucket_start, bucket, seriesSpansYears) : ""}</span>
              ))}
            </div>
          </section>}

          <div className={styles.pair}>
            <section className={styles.card}>
              <div className={styles.cardHead}><h2>{metric === "hours" ? "Hours by artist" : "Plays by artist"}</h2></div>
              <p className={styles.cardNote}>Click any bar to filter the page by it; click more to add them. This chart never filters itself.</p>
              <div className={styles.rankScroll}>
                {rankRows(
                  topArtists,
                  artistMax,
                  (row) => row.artist,
                  (row) => <>{row.artist} <small>· {count(row.tracks)} songs</small></>,
                  artistSel,
                  (key) => setArtistSel((current) => selectionAfterBarClick(current, key)),
                  // A whole artist is the Add Music discography wizard, which
                  // lives in the player itself, so this one still hops over.
                  // Songs do not - see the song chart below.
                  (row) => (
                    <a className={styles.rankAdd} href={importHref(row.artist)} target="_blank" rel="noopener" title="Open Import Music with this artist filled in">
                      Import artist
                    </a>
                  ),
                )}
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2>{metric === "hours" ? "Hours by song" : "Plays by song"}</h2>
                {missingSongs.length > 0 && (
                  <button type="button" className={styles.headAction} onClick={() => setImporting([])}>
                    Import {missingSongs.length} missing
                  </button>
                )}
              </div>
              <p className={styles.cardNote}>Click any bar to filter the page by it; click more to add them. This chart never filters itself.</p>
              <div className={styles.rankScroll}>
                {rankRows(
                  topTracks,
                  trackMax,
                  (row) => row.key,
                  (row) => <>{row.title} <small>· {row.artist}</small></>,
                  trackSel,
                  (key) => setTrackSel((current) => selectionAfterBarClick(current, key)),
                  (row) => (
                    <button
                      type="button"
                      className={styles.rankAdd}
                      onClick={() => setImporting([row.key])}
                      title="Find this on YouTube and add it, without leaving this page"
                    >
                      Add to Jukebox
                    </button>
                  ),
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      <p className={styles.footNote}>
        Hours come from how long each track actually played. A Jukebox play with no measured length falls back to
        the song&apos;s own running time, so the two sources can be added together.
        {bothSources ? " Orange is listening inside Suffering Jukebox, green is imported Spotify history." : ""}
        {Number(totals?.skipped || 0) > 0 ? ` ${count(totals?.skipped)} of these plays were skipped early.` : ""}
        {" "}<b>Add to Jukebox</b> appears beside any song the catalogue does not already hold, and imports it here without leaving the page.
      </p>

      {importing && (
        <ImportMissing
          accessToken={accessToken}
          songs={missingSongs}
          initialSelected={importing}
          onClose={() => setImporting(null)}
          // Re-read the page so the songs we just imported stop offering to
          // import themselves. in_jukebox is computed fresh on every call.
          onImported={() => setReloadTick((tick) => tick + 1)}
        />
      )}
    </div>
  );
}
