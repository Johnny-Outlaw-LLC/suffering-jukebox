"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./analytics.module.css";

export type AnalyticsPayload = {
  tz?: string;
  artistFilter?: string | null;
  totals?: {
    events?: number;
    duration_ms?: number;
    artists?: number;
    tracks?: number;
    first_played_at?: string | null;
    last_played_at?: string | null;
    skipped?: number;
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
  insights?: {
    forgottenFavorites?: Array<{
      artist: string;
      title: string;
      events: number;
      duration_ms: number;
      last_played_at?: string;
      first_played_at?: string;
    }>;
    risingArtists?: Array<{ artist: string; recent: number; prior: number; delta: number }>;
    comebacks?: Array<{ artist: string; events: number; first_played_at?: string; last_played_at?: string }>;
    binges?: Array<{ artist: string; week_start: string; events: number }>;
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
};

type DashTab = "overview" | "overtime" | "calendar" | "clock" | "artists" | "insights";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YEAR_COLORS = ["#ff6b35", "#4ecdc4", "#ffe66d", "#a78bfa", "#34d399", "#fb7185", "#60a5fa", "#f472b6"];

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
  if (x <= 0) return "#1a1a1a";
  // dark → ember → orange
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

type Props = {
  accessToken: string;
  onNeedImport: () => void;
};

export default function AnalyticsDashboard({ accessToken, onNeedImport }: Props) {
  const [tab, setTab] = useState<DashTab>("overview");
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [artistFilter, setArtistFilter] = useState<string | null>(null);
  const [artistSearch, setArtistSearch] = useState("");
  const [calendarYear, setCalendarYear] = useState<number | "all">("all");
  const [yoyMode, setYoyMode] = useState<"month" | "doy">("month");
  const [selectedYears, setSelectedYears] = useState<number[]>([]);

  async function load(artist: string | null = artistFilter) {
    setLoading(true);
    setError("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
      const params = new URLSearchParams({ analytics: "1", tz });
      if (artist) params.set("artist", artist);
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
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

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
    void load(next);
    if (next) setTab("overtime");
  }

  const totals = data?.totals;
  const habits = data?.insights?.habits;
  const maxHour = Math.max(1, ...(data?.hourDow || []).map((c) => Number(c.events) || 0));
  const artists = useMemo(() => {
    const rows = data?.artists || [];
    const q = artistSearch.trim().toLowerCase();
    return q ? rows.filter((row) => row.artist.toLowerCase().includes(q)) : rows;
  }, [artistSearch, data]);

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

  if (loading && !data) return <div className={styles.loading}>Crunching your listening history…</div>;
  if (error && !data) return <div className={styles.error}>{error}</div>;
  if (!totals?.events) {
    return (
      <section className={styles.emptyAnalytics}>
        <p className={styles.eyebrow}>Nothing to chart yet</p>
        <h2>Import your Spotify history to unlock these views</h2>
        <p className={styles.muted}>Year-over-year trends, calendars, time-of-day heatmaps, forgotten favorites, and more all run off your private export.</p>
        <button className={styles.primaryButton} onClick={onNeedImport}>Import Spotify history</button>
      </section>
    );
  }

  return (
    <section className={styles.richDash}>
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.filterBar}>
        <div className={styles.kpis}>
          <div><span>Listens</span><strong>{number(Number(totals.events || 0))}</strong></div>
          <div><span>Time</span><strong>{minutes(Number(totals.duration_ms || 0))}</strong></div>
          <div><span>Artists</span><strong>{number(Number(totals.artists || 0))}</strong></div>
          <div><span>Tracks</span><strong>{number(Number(totals.tracks || 0))}</strong></div>
        </div>
        <div className={styles.filterMeta}>
          <span>{displayDate(totals.first_played_at)} → {displayDate(totals.last_played_at)}</span>
          {artistFilter ? (
            <button className={styles.filterChip} onClick={() => pickArtist(artistFilter)} title="Clear artist filter">
              {artistFilter} ✕
            </button>
          ) : <span className={styles.muted}>Click any artist to filter every chart</span>}
          <button className={styles.secondaryButton} onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <nav className={styles.subTabs} aria-label="Analytics views">
        {([
          ["overview", "Overview"],
          ["overtime", "Over Time"],
          ["calendar", "Calendar"],
          ["clock", "Clock"],
          ["artists", "Artists"],
          ["insights", "Insights"],
        ] as Array<[DashTab, string]>).map(([id, label]) => (
          <button key={id} className={tab === id ? styles.tabActive : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {tab === "overview" && (
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
              <em>Listens after 10pm / before 5am</em>
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
              <em>Marked skipped in the export</em>
            </div>
          </div>
          <div className={styles.dashboardGrid}>
            <div className={styles.panel}>
              <h2>Top artists</h2>
              {(data?.artists || []).slice(0, 12).map((row) => (
                <button type="button" className={styles.rankBtn} key={row.artist} onClick={() => pickArtist(row.artist)}>
                  <span>{row.artist}</span>
                  <strong>{number(row.events)}</strong>
                </button>
              ))}
            </div>
            <div className={styles.panel}>
              <h2>Listening clock preview</h2>
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

      {tab === "overtime" && (
        <div className={styles.tabPane}>
          <div className={styles.toolbarRow}>
            <div className={styles.seg}>
              <button className={yoyMode === "month" ? styles.rangeActive : ""} onClick={() => setYoyMode("month")}>By month</button>
              <button className={yoyMode === "doy" ? styles.rangeActive : ""} onClick={() => setYoyMode("doy")}>Day of year</button>
            </div>
            <div className={styles.yearPills}>
              {years.map((year, idx) => {
                const on = selectedYears.includes(year);
                return (
                  <button
                    key={year}
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
              <h2>Year-over-year by month</h2>
              <div className={styles.monthGrid}>
                {MONTHS.map((label, mi) => {
                  const month = mi + 1;
                  return (
                    <div key={label} className={styles.monthCol}>
                      <span>{label}</span>
                      <div className={styles.monthBars}>
                        {selectedYears.map((year, yi) => {
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
              <h2>Day-of-year comparison</h2>
              <p className={styles.muted}>Each line is a year. Spikes show seasons and rituals that come back every calendar.</p>
              <svg className={styles.doyChart} viewBox="0 0 740 220" role="img" aria-label="Day of year listening by year">
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <line key={t} x1="40" x2="720" y1={20 + t * 160} y2={20 + t * 160} stroke="#2a2a2a" />
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
                  return <polyline key={year} fill="none" stroke={color} strokeWidth="1.6" points={points} opacity="0.9" />;
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
                <button key={year} className={calendarYear === year ? styles.yearOn : styles.yearOff} onClick={() => setCalendarYear(year)}>{year}</button>
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

      {tab === "clock" && (
        <div className={styles.tabPane}>
          <div className={styles.panel}>
            <h2>Time of day × day of week</h2>
            <p className={styles.muted}>Where your ears actually live. Darker cells are quiet; orange is heavy listening.</p>
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
              placeholder="Search artists"
              aria-label="Search artists"
            />
            <span className={styles.muted}>Top {number(artists.length)} · click to filter all views</span>
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

      {tab === "insights" && (
        <div className={styles.tabPane}>
          <div className={styles.insightGrid}>
            <div className={styles.panel}>
              <p className={styles.eyebrow}>Forgotten favorites</p>
              <h2>Loved hard, left behind</h2>
              <p className={styles.muted}>8+ plays historically, quiet for 180+ days.</p>
              {(data?.insights?.forgottenFavorites || []).map((row) => (
                <button type="button" className={styles.insightRow} key={`${row.artist}-${row.title}`} onClick={() => pickArtist(row.artist)}>
                  <div>
                    <strong>{row.title}</strong>
                    <span>{row.artist}</span>
                  </div>
                  <em>{number(row.events)} plays · last {displayDate(row.last_played_at)}</em>
                </button>
              ))}
              {!data?.insights?.forgottenFavorites?.length && <p className={styles.emptyState}>Nothing dusty enough yet.</p>}
            </div>

            <div className={styles.panel}>
              <p className={styles.eyebrow}>Comebacks</p>
              <h2>Old friends, new chapters</h2>
              <p className={styles.muted}>Artists from years ago who returned in the last 90 days after a long gap.</p>
              {(data?.insights?.comebacks || []).map((row) => (
                <button type="button" className={styles.insightRow} key={row.artist} onClick={() => pickArtist(row.artist)}>
                  <div>
                    <strong>{row.artist}</strong>
                    <span>First {displayDate(row.first_played_at)}</span>
                  </div>
                  <em>Back since {displayDate(row.last_played_at)}</em>
                </button>
              ))}
              {!data?.insights?.comebacks?.length && <p className={styles.emptyState}>No comeback arcs in this window.</p>}
            </div>

            <div className={styles.panel}>
              <p className={styles.eyebrow}>Rising now</p>
              <h2>Heating up</h2>
              <p className={styles.muted}>Last 90 days at least 2× the 90 days before that.</p>
              {(data?.insights?.risingArtists || []).slice(0, 15).map((row) => (
                <button type="button" className={styles.insightRow} key={row.artist} onClick={() => pickArtist(row.artist)}>
                  <div>
                    <strong>{row.artist}</strong>
                    <span>{number(row.prior)} → {number(row.recent)}</span>
                  </div>
                  <em>+{number(row.delta)}</em>
                </button>
              ))}
              {!data?.insights?.risingArtists?.length && <p className={styles.emptyState}>No surge artists right now.</p>}
            </div>

            <div className={styles.panel}>
              <p className={styles.eyebrow}>Biggest weeks</p>
              <h2>Binge seasons</h2>
              <p className={styles.muted}>Single-week artist obsessions across your history.</p>
              {(data?.insights?.binges || []).map((row) => (
                <button type="button" className={styles.insightRow} key={`${row.artist}-${row.week_start}`} onClick={() => pickArtist(row.artist)}>
                  <div>
                    <strong>{row.artist}</strong>
                    <span>Week of {displayDate(row.week_start)}</span>
                  </div>
                  <em>{number(row.events)} listens</em>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
