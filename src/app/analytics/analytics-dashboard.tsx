"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./analytics.module.css";

export type AnalyticsPayload = {
  tz?: string;
  source?: string;
  artistFilter?: string | null;
  from?: string | null;
  to?: string | null;
  totals?: {
    events?: number;
    duration_ms?: number;
    artists?: number;
    tracks?: number;
    first_played_at?: string | null;
    last_played_at?: string | null;
    skipped?: number;
    spotify_events?: number;
    jukebox_events?: number;
  };
  byMonth?: Array<{ year: number; month: number; events: number; duration_ms: number }>;
  byDayOfYear?: Array<{ year: number; doy: number; events: number }>;
  calendar?: Array<{ day: string; events: number; duration_ms: number }>;
  hourDow?: Array<{ dow: number; hour: number; events: number; duration_ms: number }>;
  artists?: Array<{
    artist: string;
    events: number;
    duration_ms: number;
    first_played_at?: string;
    last_played_at?: string;
    tracks?: number;
  }>;
  artistOptions?: Array<{ artist: string; events: number }>;
  habits?: {
    peakHour?: number;
    peakDow?: number;
    nightOwlShare?: number;
    weekendShare?: number;
    avgPerActiveDay?: number;
    activeDays?: number;
    skipRate?: number;
    uniqueArtists?: number;
    uniqueTracks?: number;
  };
};

type DashTab = "snapshot" | "timeline" | "calendar" | "when" | "artists";
type SourceFilter = "all" | "jukebox" | "spotify";
type DatePreset = "all" | "30d" | "90d" | "365d" | "custom";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR_COLORS = ["#ff6b35", "#4ecdc4", "#ffe66d", "#a78bfa", "#34d399", "#fb7185", "#60a5fa", "#f472b6"];
const TABS: Array<[DashTab, string, string]> = [
  ["snapshot", "Snapshot", "The shape of your listening"],
  ["timeline", "Timeline", "Year over year"],
  ["calendar", "Calendar", "Every active day"],
  ["when", "When", "Hour × weekday"],
  ["artists", "Artists", "Who you play most"],
];

function number(value: number) {
  return new Intl.NumberFormat().format(value || 0);
}
function minutes(ms: number) {
  const total = Math.max(0, Math.round((ms || 0) / 60000));
  const hours = Math.floor(total / 60);
  const days = Math.floor(hours / 24);
  if (days >= 2) return `${days}d ${hours % 24}h`;
  return hours ? `${hours}h ${total % 60}m` : `${total}m`;
}
function displayDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function heatColor(t: number) {
  const x = Math.max(0, Math.min(1, t));
  if (x <= 0) return "rgba(255,255,255,.04)";
  const r = Math.round(40 + x * 215);
  const g = Math.round(20 + x * 87);
  const b = Math.round(18 + x * 35);
  return `rgb(${r},${g},${b})`;
}
function hourLabel(h: number) {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}
function toDateInput(d: Date) {
  return d.toISOString().slice(0, 10);
}
function startOfDayIso(ymd: string) {
  return new Date(`${ymd}T00:00:00`).toISOString();
}
function endExclusiveIso(ymd: string) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

type Props = {
  accessToken: string;
  onNeedImport: () => void;
};

export default function AnalyticsDashboard({ accessToken, onNeedImport }: Props) {
  const [tab, setTab] = useState<DashTab>("snapshot");
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [artistFilter, setArtistFilter] = useState<string | null>(null);
  const [artistQuery, setArtistQuery] = useState("");
  const [artistSearch, setArtistSearch] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [calendarYear, setCalendarYear] = useState<number | "all">("all");
  const [yoyMode, setYoyMode] = useState<"month" | "doy">("month");
  const [selectedYears, setSelectedYears] = useState<number[]>([]);

  const range = useMemo(() => {
    const now = new Date();
    if (datePreset === "all") return { from: null as string | null, to: null as string | null };
    if (datePreset === "custom") {
      return {
        from: customFrom ? startOfDayIso(customFrom) : null,
        to: customTo ? endExclusiveIso(customTo) : null,
      };
    }
    const days = datePreset === "30d" ? 30 : datePreset === "90d" ? 90 : 365;
    const from = new Date(now);
    from.setDate(from.getDate() - days);
    return { from: from.toISOString(), to: null as string | null };
  }, [customFrom, customTo, datePreset]);

  async function load(opts?: {
    source?: SourceFilter;
    artist?: string | null;
    from?: string | null;
    to?: string | null;
  }) {
    setLoading(true);
    setError("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
      const params = new URLSearchParams({ analytics: "1", tz, source: opts?.source ?? source });
      const artist = opts?.artist === undefined ? artistFilter : opts.artist;
      const from = opts?.from === undefined ? range.from : opts.from;
      const to = opts?.to === undefined ? range.to : opts.to;
      if (artist) params.set("artist", artist);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const response = await fetch(`/api/spotify/history?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || "Could not load analytics.");
      setData(json.analytics || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load analytics.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, source, artistFilter, range.from, range.to]);

  const years = useMemo(() => {
    const set = new Set<number>();
    (data?.byMonth || []).forEach((row) => set.add(row.year));
    return [...set].sort((a, b) => b - a);
  }, [data]);

  useEffect(() => {
    if (!years.length) return;
    setSelectedYears((current) => {
      if (current.length) return current.filter((y) => years.includes(y));
      return years.slice(0, Math.min(4, years.length));
    });
    if (calendarYear === "all" && years[0]) setCalendarYear(years[0]);
  }, [years]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickArtist(artist: string) {
    const next = artistFilter === artist ? null : artist;
    setArtistFilter(next);
    setArtistQuery(next || "");
    if (next) setTab("timeline");
  }

  function clearFilters() {
    setSource("all");
    setArtistFilter(null);
    setArtistQuery("");
    setDatePreset("all");
    setCustomFrom("");
    setCustomTo("");
  }

  const totals = data?.totals;
  const habits = data?.habits;
  const maxHour = Math.max(1, ...(data?.hourDow || []).map((c) => Number(c.events) || 0));
  const artists = useMemo(() => {
    const rows = data?.artists || [];
    const q = artistSearch.trim().toLowerCase();
    return q ? rows.filter((row) => row.artist.toLowerCase().includes(q)) : rows;
  }, [artistSearch, data]);

  const artistOptions = useMemo(() => {
    const rows = data?.artistOptions || data?.artists || [];
    const q = artistQuery.trim().toLowerCase();
    if (!q || artistFilter === artistQuery) return rows.slice(0, 12);
    return rows.filter((row) => row.artist.toLowerCase().includes(q)).slice(0, 12);
  }, [artistFilter, artistQuery, data]);

  const monthMatrix = useMemo(() => {
    const map = new Map<string, number>();
    (data?.byMonth || []).forEach((row) => map.set(`${row.year}-${row.month}`, Number(row.events) || 0));
    const max = Math.max(1, ...[...map.values()]);
    return { map, max };
  }, [data]);

  const doyByYear = useMemo(() => {
    const byYear = new Map<number, number[]>();
    (data?.byDayOfYear || []).forEach((row) => {
      if (!byYear.has(row.year)) byYear.set(row.year, Array(366).fill(0));
      const arr = byYear.get(row.year)!;
      const idx = Math.max(1, Math.min(366, row.doy)) - 1;
      arr[idx] = Number(row.events) || 0;
    });
    return byYear;
  }, [data]);

  const calendarCells = useMemo(() => {
    const byDay = new Map((data?.calendar || []).map((row) => [row.day, Number(row.events) || 0]));
    if (calendarYear === "all") {
      return [...byDay.entries()].map(([day, events]) => ({ day, events }));
    }
    const days: Array<{ day: string; events: number }> = [];
    const start = new Date(Date.UTC(calendarYear, 0, 1));
    const end = new Date(Date.UTC(calendarYear, 11, 31));
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      days.push({ day, events: byDay.get(day) || 0 });
    }
    return days;
  }, [calendarYear, data]);

  const calendarMax = Math.max(1, ...calendarCells.map((c) => c.events));

  const githubWeeks = useMemo(() => {
    if (!calendarCells.length) return [];
    const first = new Date(calendarCells[0].day + "T12:00:00");
    const pad = first.getDay();
    const cells: Array<{ day: string; events: number } | null> = [
      ...Array(pad).fill(null),
      ...calendarCells,
    ];
    const weeks: Array<Array<{ day: string; events: number } | null>> = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [calendarCells]);

  const hasAny = Number(totals?.events || 0) > 0;
  const filtersActive = source !== "all" || !!artistFilter || datePreset !== "all";

  if (loading && !data) return <div className={styles.loading}>Crunching your listening…</div>;
  if (error && !data) return <div className={styles.error}>{error}</div>;

  if (!hasAny && !filtersActive) {
    return (
      <section className={styles.emptyAnalytics}>
        <p className={styles.eyebrow}>Nothing to chart yet</p>
        <h2>Import Spotify history — or play something here</h2>
        <p className={styles.muted}>
          Snapshot, Timeline, Calendar, and When all run off your private listens: Suffering Jukebox plays plus any Spotify export you import.
        </p>
        <button className={styles.primaryButton} onClick={onNeedImport}>Import Spotify history</button>
      </section>
    );
  }

  return (
    <section className={styles.richDash}>
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.controlRail}>
        <div className={styles.controlBlock}>
          <span className={styles.controlLabel}>Source</span>
          <div className={styles.seg} role="group" aria-label="Listening source">
            {([
              ["all", "All"],
              ["jukebox", "Suffering Jukebox"],
              ["spotify", "Spotify"],
            ] as Array<[SourceFilter, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={source === id ? styles.rangeActive : ""}
                onClick={() => setSource(id)}
              >{label}</button>
            ))}
          </div>
        </div>

        <div className={styles.controlBlock}>
          <span className={styles.controlLabel}>Date</span>
          <div className={styles.seg} role="group" aria-label="Date range">
            {([
              ["all", "All time"],
              ["30d", "30 days"],
              ["90d", "90 days"],
              ["365d", "1 year"],
              ["custom", "Custom"],
            ] as Array<[DatePreset, string]>).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={datePreset === id ? styles.rangeActive : ""}
                onClick={() => {
                  setDatePreset(id);
                  if (id === "custom" && !customFrom && !customTo) {
                    const end = new Date();
                    const start = new Date();
                    start.setFullYear(start.getFullYear() - 1);
                    setCustomFrom(toDateInput(start));
                    setCustomTo(toDateInput(end));
                  }
                }}
              >{label}</button>
            ))}
          </div>
          {datePreset === "custom" && (
            <div className={styles.customDates}>
              <label>
                From
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </label>
            </div>
          )}
        </div>

        <div className={styles.controlBlock}>
          <span className={styles.controlLabel}>Artist</span>
          <div className={styles.artistPicker}>
            <input
              className={styles.artistSearch}
              type="search"
              value={artistQuery}
              onChange={(e) => {
                const value = e.target.value;
                setArtistQuery(value);
                if (!value) {
                  setArtistFilter(null);
                  return;
                }
                const exact = (data?.artistOptions || data?.artists || []).find(
                  (row) => row.artist.toLowerCase() === value.trim().toLowerCase(),
                );
                if (exact) {
                  setArtistFilter(exact.artist);
                  setArtistQuery(exact.artist);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && artistQuery.trim()) {
                  setArtistFilter(artistQuery.trim());
                  setTab("timeline");
                }
                if (e.key === "Escape") {
                  setArtistQuery("");
                  setArtistFilter(null);
                }
              }}
              placeholder="Filter by artist…"
              aria-label="Filter by artist"
              list="sj-analytics-artists"
            />
            <datalist id="sj-analytics-artists">
              {(data?.artistOptions || []).slice(0, 80).map((row) => (
                <option key={row.artist} value={row.artist} />
              ))}
            </datalist>
            {artistQuery && artistOptions.length > 0 && !artistFilter && (
              <div className={styles.artistSuggest}>
                {artistOptions.map((row) => (
                  <button key={row.artist} type="button" onClick={() => pickArtist(row.artist)}>
                    <span>{row.artist}</span>
                    <em>{number(row.events)}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.controlActions}>
          {filtersActive && (
            <button type="button" className={styles.ghostBtn} onClick={clearFilters}>Clear filters</button>
          )}
          <button type="button" className={styles.secondaryButton} onClick={() => void load()} disabled={loading}>
            {loading ? "Updating…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className={styles.heroStats}>
        <div className={styles.heroStat}>
          <span>Listens</span>
          <strong>{number(Number(totals?.events || 0))}</strong>
          <em>{displayDate(totals?.first_played_at)} → {displayDate(totals?.last_played_at)}</em>
        </div>
        <div className={styles.heroStat}>
          <span>Time</span>
          <strong>{minutes(Number(totals?.duration_ms || 0))}</strong>
          <em>{number(Number(totals?.tracks || 0))} tracks</em>
        </div>
        <div className={styles.heroStat}>
          <span>Artists</span>
          <strong>{number(Number(totals?.artists || 0))}</strong>
          <em>
            {number(Number(totals?.jukebox_events || 0))} jukebox · {number(Number(totals?.spotify_events || 0))} Spotify
          </em>
        </div>
        {artistFilter && (
          <button type="button" className={styles.filterChip} onClick={() => pickArtist(artistFilter)}>
            {artistFilter} ✕
          </button>
        )}
      </div>

      {!hasAny && filtersActive ? (
        <div className={styles.emptyFiltered}>
          <h2>No listens match these filters</h2>
          <p className={styles.muted}>Widen the date range, switch source, or clear the artist filter.</p>
          <button type="button" className={styles.secondaryButton} onClick={clearFilters}>Clear filters</button>
        </div>
      ) : (
        <>
          <nav className={styles.subTabs} aria-label="Analytics views">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" className={tab === id ? styles.tabActive : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>

          {tab === "snapshot" && (
            <div className={styles.tabPane}>
              <div className={styles.habitCards}>
                <div className={styles.habitCard}>
                  <span>Peak hour</span>
                  <strong>{hourLabel(Number(habits?.peakHour || 0))}</strong>
                  <em>When you listen most</em>
                </div>
                <div className={styles.habitCard}>
                  <span>Peak day</span>
                  <strong>{DOW[Number(habits?.peakDow || 0)]}</strong>
                  <em>Your heaviest weekday</em>
                </div>
                <div className={styles.habitCard}>
                  <span>Night owl</span>
                  <strong>{Number(habits?.nightOwlShare || 0)}%</strong>
                  <em>After 10pm / before 5am</em>
                </div>
                <div className={styles.habitCard}>
                  <span>Weekend</span>
                  <strong>{Number(habits?.weekendShare || 0)}%</strong>
                  <em>Share of weekend listening</em>
                </div>
                <div className={styles.habitCard}>
                  <span>Active days</span>
                  <strong>{number(Number(habits?.activeDays || 0))}</strong>
                  <em>~{Number(habits?.avgPerActiveDay || 0)} listens / day</em>
                </div>
                <div className={styles.habitCard}>
                  <span>Skip rate</span>
                  <strong>{Number(habits?.skipRate || 0)}%</strong>
                  <em>Marked skipped in Spotify export</em>
                </div>
              </div>
              <div className={styles.dashboardGrid}>
                <div className={styles.panel}>
                  <div className={styles.panelHead}>
                    <h2>Top artists</h2>
                    <button type="button" className={styles.linkBtn} onClick={() => setTab("artists")}>See all</button>
                  </div>
                  {(data?.artists || []).slice(0, 10).map((row, i) => (
                    <button type="button" className={styles.rankBtn} key={row.artist} onClick={() => pickArtist(row.artist)}>
                      <em>{i + 1}</em>
                      <span>{row.artist}</span>
                      <strong>{number(row.events)}</strong>
                    </button>
                  ))}
                </div>
                <div className={styles.panel}>
                  <div className={styles.panelHead}>
                    <h2>Listening clock</h2>
                    <button type="button" className={styles.linkBtn} onClick={() => setTab("when")}>Expand</button>
                  </div>
                  <div className={styles.miniClock}>
                    {DOW.map((label, dow) => (
                      <div key={label} className={styles.miniClockRow}>
                        <span>{label}</span>
                        <div>
                          {Array.from({ length: 24 }, (_, hour) => {
                            const cell = (data?.hourDow || []).find((c) => c.dow === dow && c.hour === hour);
                            const t = (Number(cell?.events || 0) / maxHour);
                            return <i key={hour} style={{ background: heatColor(t) }} title={`${label} ${hourLabel(hour)}: ${number(Number(cell?.events || 0))}`} />;
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "timeline" && (
            <div className={styles.tabPane}>
              <div className={styles.toolbarRow}>
                <div className={styles.seg}>
                  <button type="button" className={yoyMode === "month" ? styles.rangeActive : ""} onClick={() => setYoyMode("month")}>By month</button>
                  <button type="button" className={yoyMode === "doy" ? styles.rangeActive : ""} onClick={() => setYoyMode("doy")}>Day of year</button>
                </div>
                <div className={styles.yearPills}>
                  {years.map((year, idx) => {
                    const on = selectedYears.includes(year);
                    return (
                      <button
                        key={year}
                        type="button"
                        className={on ? styles.yearOn : styles.yearOff}
                        style={on ? { borderColor: YEAR_COLORS[idx % YEAR_COLORS.length], color: YEAR_COLORS[idx % YEAR_COLORS.length] } : undefined}
                        onClick={() => setSelectedYears((cur) => on ? cur.filter((y) => y !== year) : [...cur, year].sort((a, b) => b - a))}
                      >{year}</button>
                    );
                  })}
                </div>
              </div>

              {yoyMode === "month" ? (
                <div className={styles.panel}>
                  <h2>Year over year by month</h2>
                  <div className={styles.monthGrid}>
                    {MONTHS.map((label, mi) => {
                      const month = mi + 1;
                      return (
                        <div key={label} className={styles.monthCol}>
                          <span>{label}</span>
                          <div className={styles.monthBars}>
                            {selectedYears.map((year) => {
                              const events = monthMatrix.map.get(`${year}-${month}`) || 0;
                              const h = Math.max(events ? 4 : 0, Math.round((events / monthMatrix.max) * 120));
                              return (
                                <div
                                  key={year}
                                  className={styles.monthBar}
                                  style={{ height: h, background: YEAR_COLORS[years.indexOf(year) % YEAR_COLORS.length] }}
                                  title={`${MONTHS[mi]} ${year}: ${number(events)} listens`}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className={styles.legend}>
                    {selectedYears.map((year) => (
                      <span key={year}><i style={{ background: YEAR_COLORS[years.indexOf(year) % YEAR_COLORS.length] }} />{year}</span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={styles.panel}>
                  <h2>Day of year</h2>
                  <p className={styles.muted}>Each line is a year. Spikes are seasons that come back.</p>
                  <svg className={styles.doyChart} viewBox="0 0 740 220" role="img" aria-label="Day of year listening by year">
                    {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                      <line key={t} x1="40" x2="720" y1={20 + t * 160} y2={20 + t * 160} stroke="rgba(255,255,255,.06)" />
                    ))}
                    {selectedYears.map((year) => {
                      const series = doyByYear.get(year) || Array(366).fill(0);
                      const max = Math.max(1, ...series);
                      const color = YEAR_COLORS[years.indexOf(year) % YEAR_COLORS.length];
                      const points = series.map((v, i) => {
                        const x = 40 + (i / 365) * 680;
                        const y = 180 - (v / max) * 160;
                        return `${x},${y}`;
                      }).join(" ");
                      return <polyline key={year} fill="none" stroke={color} strokeWidth="1.8" points={points} opacity="0.92" />;
                    })}
                    {[0, 90, 181, 273, 365].map((d, i) => (
                      <text key={d} x={40 + (d / 365) * 680} y="205" fill="#777" fontSize="10" textAnchor="middle">{MONTHS[i * 3] || "Dec"}</text>
                    ))}
                  </svg>
                  <div className={styles.legend}>
                    {selectedYears.map((year) => (
                      <span key={year}><i style={{ background: YEAR_COLORS[years.indexOf(year) % YEAR_COLORS.length] }} />{year}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "calendar" && (
            <div className={styles.tabPane}>
              <div className={styles.toolbarRow}>
                <div className={styles.yearPills}>
                  {years.map((year) => (
                    <button key={year} type="button" className={calendarYear === year ? styles.yearOn : styles.yearOff} onClick={() => setCalendarYear(year)}>{year}</button>
                  ))}
                </div>
                <span className={styles.muted}>{number(calendarCells.filter((c) => c.events > 0).length)} active days · max {number(calendarMax)} in a day</span>
              </div>
              <div className={styles.panel}>
                <h2>Listening calendar</h2>
                <div className={styles.calWrap}>
                  <div className={styles.calDow}>
                    {DOW.map((d) => <span key={d}>{d[0]}</span>)}
                  </div>
                  <div className={styles.calGrid}>
                    {githubWeeks.map((week, wi) => (
                      <div key={wi} className={styles.calWeek}>
                        {week.map((cell, di) => cell ? (
                          <i
                            key={cell.day}
                            style={{ background: heatColor(cell.events / calendarMax) }}
                            title={`${cell.day}: ${number(cell.events)} listens`}
                          />
                        ) : <i key={`e-${wi}-${di}`} className={styles.calEmpty} />)}
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.heatLegend}>
                  <span>Less</span>
                  {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => <i key={t} style={{ background: heatColor(t) }} />)}
                  <span>More</span>
                </div>
              </div>
            </div>
          )}

          {tab === "when" && (
            <div className={styles.tabPane}>
              <div className={styles.panel}>
                <h2>Time of day × weekday</h2>
                <p className={styles.muted}>Where your ears actually live. Quiet cells stay dark; orange is heavy.</p>
                <div className={styles.clockHeat}>
                  <div className={styles.clockHead}>
                    <span />
                    {Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? hourLabel(h) : ""}</span>)}
                  </div>
                  {DOW.map((label, dow) => (
                    <div key={label} className={styles.clockRow}>
                      <span>{label}</span>
                      {Array.from({ length: 24 }, (_, hour) => {
                        const cell = (data?.hourDow || []).find((c) => c.dow === dow && c.hour === hour);
                        const events = Number(cell?.events || 0);
                        return (
                          <i
                            key={hour}
                            style={{ background: heatColor(events / maxHour) }}
                            title={`${label} ${hourLabel(hour)}: ${number(events)} listens`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "artists" && (
            <div className={styles.tabPane}>
              <div className={styles.toolbarRow}>
                <input
                  className={styles.artistSearch}
                  type="search"
                  value={artistSearch}
                  onChange={(event) => setArtistSearch(event.target.value)}
                  placeholder="Search artists in this view"
                  aria-label="Search artists"
                />
                <span className={styles.muted}>{number(artists.length)} artists · click to filter everything</span>
              </div>
              <div className={styles.artistTable}>
                <div className={styles.artistHead}><span>Artist</span><span>Listens</span><span>Tracks</span><span>Time</span><span>First</span><span>Last</span></div>
                {artists.map((row) => (
                  <button
                    type="button"
                    key={row.artist}
                    className={`${styles.artistLine} ${artistFilter === row.artist ? styles.artistLineOn : ""}`}
                    onClick={() => pickArtist(row.artist)}
                  >
                    <span>{row.artist}</span>
                    <strong>{number(row.events)}</strong>
                    <em>{number(Number(row.tracks || 0))}</em>
                    <em>{minutes(Number(row.duration_ms || 0))}</em>
                    <em>{displayDate(row.first_played_at)}</em>
                    <em>{displayDate(row.last_played_at)}</em>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
