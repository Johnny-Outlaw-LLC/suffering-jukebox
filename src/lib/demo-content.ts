// Fictional content for public demos. No account, API, or catalog records.
// Dates are anchored to the viewer's current day; filters aggregate the same events.
import type { Stats } from "@/app/artist-stats/stats-dashboard";
import type { AnalyticsPayload, AnalyticsQuery } from "@/app/analytics/analytics-dashboard";

export const DEMO_ARTIST = "Harbor Signal";
export const DEMO_ALBUM = "Midnight Windows";
export const DEMO_LYRICS = [
  { t: 12, text: "We leave the lights on for the morning" },
  { t: 18, text: "Let the city find its way back home" },
  { t: 25, text: "Every window holds a little daylight" },
  { t: 32, text: "Even when the streets are quiet" },
  { t: 40, text: "Take the long road, I will meet you there" },
  { t: 48, text: "We have time to start again" },
];
export const DEMO_TRACKS = [
  { title: "Night Drive", artist: DEMO_ARTIST, album: DEMO_ALBUM, seconds: 224, completion: .91 },
  { title: "First Light", artist: DEMO_ARTIST, album: DEMO_ALBUM, seconds: 201, completion: .87 },
  { title: "Paper Satellites", artist: DEMO_ARTIST, album: DEMO_ALBUM, seconds: 238, completion: .85 },
  { title: "Stay Awhile", artist: DEMO_ARTIST, album: DEMO_ALBUM, seconds: 192, completion: .89 },
  { title: "Window Seat", artist: DEMO_ARTIST, album: DEMO_ALBUM, seconds: 213, completion: .83 },
  { title: "Home Again", artist: DEMO_ARTIST, album: DEMO_ALBUM, seconds: 246, completion: .86 },
  { title: "Soft Landing", artist: "June Arcade", album: "Small Hours", seconds: 207, completion: .9 },
  { title: "Blue Hour", artist: "The Lantern Maps", album: "Open Roads", seconds: 219, completion: .88 },
  { title: "Sunday Weather", artist: "Mira Coast", album: "Daylight Notes", seconds: 184, completion: .84 },
  { title: "Out of the Static", artist: "June Arcade", album: "Small Hours", seconds: 230, completion: .9 },
  { title: "Eastbound", artist: "The Lantern Maps", album: "Open Roads", seconds: 211, completion: .86 },
  { title: "A Place to Begin", artist: "Mira Coast", album: "Daylight Notes", seconds: 205, completion: .88 },
];
export const demoTrackKey = (track: { artist: string; title: string }) => `${track.artist}\u001f${track.title}`;
const dayMs = 86400000;
function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function ago(now: Date, days: number) {
  const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days); return d;
}
function allocate(total: number, weights: number[]) {
  let used = 0;
  return weights.map((weight, i) => {
    const n = i === weights.length - 1 ? total - used : Math.round(total * weight);
    used += n; return n;
  });
}

export function demoArtistStats(days: number, now = new Date()): Stats {
  const history = Array.from({ length: 730 }, (_, index) => {
    const age = 729 - index;
    const date = ago(now, age);
    const base = 46 + Math.round((729 - age) * .17) + [12, 2, 7, 14, 22, 38, 27][date.getDay()];
    const release = age < 21 ? 170 + (21 - age) * 9 : 0;
    const feature = age < 8 ? 230 + (8 - age) * 12 : 0;
    const plays = base + release + feature;
    return { day: dayKey(date), plays, listeners: Math.round(plays * .62) };
  });
  const daily = history.slice(-days);
  const plays = daily.reduce((sum, d) => sum + d.plays, 0);
  const previous = history.slice(-days * 2, -days).reduce((sum, d) => sum + d.plays, 0);
  const counts = allocate(plays, [.34, .21, .16, .12, .1, .07]);
  const songs = DEMO_TRACKS.slice(0, 6).map((track, i) => ({
    track_id: `demo-track-${i}`, name: track.title, album: track.album,
    duration_ms: track.seconds * 1000, plays: counts[i], listeners: Math.round(counts[i] * .68),
    listen_ms: Math.round(counts[i] * track.seconds * 1000 * track.completion), timed_plays: counts[i],
    completion: track.completion, hearts: Math.round(counts[i] * .06),
    quotes: Math.round(counts[i] * .018), playlist_adds: Math.round(counts[i] * .028),
  }));
  const listeners = Math.round(plays * .37);
  const contexts = allocate(plays, [.32, .41, .27]);
  const visits = Math.round(plays * .24);
  const refs = allocate(visits, [.41, .29, .18, .12]);
  const cities = allocate(listeners, [.26, .2, .17, .15, .12, .1]);
  return {
    artist: { id: "demo-harbor-signal", name: DEMO_ARTIST, slug: "harbor-signal" },
    range: { days, since: daily[0].day, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago" },
    totals: {
      plays, listeners, returning_listeners: Math.round(listeners * .38),
      listen_ms: songs.reduce((sum, s) => sum + s.listen_ms, 0), timed_plays: plays,
      prev_plays: previous, prev_listeners: Math.round(previous * .37),
      hearts: songs.reduce((sum, s) => sum + s.hearts, 0), quotes: songs.reduce((sum, s) => sum + s.quotes, 0),
      playlist_adds: songs.reduce((sum, s) => sum + s.playlist_adds, 0), page_visits: visits,
      all_time_plays: history.reduce((sum, d) => sum + d.plays, 0), tracks: songs.length,
    },
    daily, songs,
    moments: songs.slice(0, 3).map((s, i) => ({ track_id: s.track_id, name: s.name, duration_ms: s.duration_ms,
      start_ms: DEMO_LYRICS[i].t * 1000, n: Math.round(s.hearts * .4), total: s.hearts,
      lyric: DEMO_LYRICS[i].text, buckets: [{ s: DEMO_LYRICS[i].t, n: Math.round(s.hearts * .4) }, { s: 60, n: s.hearts - Math.round(s.hearts * .4) }],
    })),
    quotes: songs.slice(0, 3).map((s, i) => ({ track_id: s.track_id, name: s.name, quote: DEMO_LYRICS[i].text, n: s.quotes })),
    contexts: { web: contexts[0], app_background: contexts[1], native: contexts[2] },
    surfaces: { lp: plays }, sources: { audio: plays, video: 0 },
    places: { top: ["Chicago", "Austin", "Portland", "New York", "London"].map((city, i) => ({ city, country: i === 4 ? "United Kingdom" : "United States", listeners: cities[i], plays: Math.round(cities[i] / listeners * plays) })), other_listeners: cities[5], unlocated_listeners: 0 },
    referrers: ["Playlist feature", "Instagram", "Artist newsletter", "Direct link or typed in"].map((source, i) => ({ source, visits: refs[i] })),
    context_since: history[0].day,
  };
}

type DemoSource = "sj" | "lp" | "spotify" | "youtube";
export type DemoEvent = { day: string; hour: number; dow: number; track: number; source: DemoSource; duration: number; heart: boolean };
export function demoListeningEvents(now = new Date()): DemoEvent[] {
  const events: DemoEvent[] = [];
  for (let age = 364; age >= 0; age--) {
    const date = ago(now, age);
    const n = 8 + age % 5 + (date.getDay() === 0 || date.getDay() === 6 ? 6 : 0);
    for (let i = 0; i < n; i++) {
      const track = age < 21 && i % 3 !== 0 ? i % 6 : (age * 7 + i * 3) % DEMO_TRACKS.length;
      const source: DemoSource = age < 21 && i % 3 !== 0 ? "lp" : (["spotify", "sj", "youtube", "lp"] as const)[(age + i) % 4];
      events.push({ day: dayKey(date), dow: date.getDay(), hour: [8, 9, 12, 17, 18, 20, 21][i % 7], track, source,
        duration: source === "youtube" ? 0 : Math.round(DEMO_TRACKS[track].seconds * 1000 * (.76 + (i % 4) * .06)), heart: (age + i) % 11 === 0 });
    }
  }
  return events.sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour);
}

function selectionIncludes(selection: AnalyticsQuery["artistSel"], key: string) {
  if (selection.mode === "all") return true;
  if (selection.mode === "none") return false;
  const has = selection.keys.includes(key);
  return selection.mode === "include" ? has : !has;
}
function split(events: DemoEvent[]) {
  const result = { duration_ms: 0, events: 0, sj_ms: 0, lp_ms: 0, spotify_ms: 0, youtube_ms: 0, jukebox_ms: 0,
    sj_events: 0, lp_events: 0, spotify_events: 0, youtube_events: 0, jukebox_events: 0 };
  for (const event of events) {
    result.events++; result.duration_ms += event.duration;
    result[`${event.source}_events`]++; result[`${event.source}_ms`] += event.duration;
    if (event.source === "sj" || event.source === "lp") { result.jukebox_events++; result.jukebox_ms += event.duration; }
  }
  return result;
}
function group<T>(events: DemoEvent[], key: (event: DemoEvent) => string, row: (key: string, events: DemoEvent[]) => T) {
  const groups = new Map<string, DemoEvent[]>();
  for (const event of events) { const k = key(event); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(event); }
  return [...groups].map(([k, rows]) => row(k, rows));
}
function bucketDay(day: string, bucket: "day" | "week" | "month" | "year") {
  const date = new Date(day + "T12:00:00");
  if (bucket === "week") date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  if (bucket === "month") date.setDate(1);
  if (bucket === "year") { date.setMonth(0); date.setDate(1); }
  return dayKey(date);
}

export function demoAnalytics(query: AnalyticsQuery, events: DemoEvent[], imported: ReadonlySet<string> = new Set()): AnalyticsPayload {
  const platform = events.filter(e => {
    if (query.source === "all") return true;
    if (query.source === "jukebox") return e.source === "sj" || e.source === "lp";
    return e.source === query.source;
  });
  const dates = platform.filter(e => (!query.from || e.day >= query.from) && (!query.to || e.day <= query.to));
  const filtered = dates.filter(e => selectionIncludes(query.artistSel, DEMO_TRACKS[e.track].artist) && selectionIncludes(query.trackSel, demoTrackKey(DEMO_TRACKS[e.track])));
  const span = filtered.length ? (new Date(filtered.at(-1)!.day).getTime() - new Date(filtered[0].day).getTime()) / dayMs : 30;
  const bucket = query.bucketMode === "auto" ? span < 100 ? "day" : "month" : query.bucketMode;
  const inCatalog = (index: number) => index < 6 || imported.has(demoTrackKey(DEMO_TRACKS[index]));
  const byArtist = (rows: DemoEvent[]) => group(rows, e => DEMO_TRACKS[e.track].artist, (artist, es) => ({ artist, tracks: new Set(es.map(e => e.track)).size, in_jukebox: es.some(e => inCatalog(e.track)), ...split(es) })).sort((a, b) => b.events - a.events);
  const byTrack = (rows: DemoEvent[]) => group(rows, e => String(e.track), (index, es) => ({ key: demoTrackKey(DEMO_TRACKS[Number(index)]), title: DEMO_TRACKS[Number(index)].title, artist: DEMO_TRACKS[Number(index)].artist, in_jukebox: inCatalog(Number(index)), ...split(es) })).sort((a, b) => b.events - a.events);
  const hearts = filtered.filter(e => e.heart);
  const playlistTracks = [[0, 1, 2, 7, 10], [6, 8, 9, 11], [0, 3, 4, 5]];
  const eventTime = (e: DemoEvent | undefined) => e ? new Date(`${e.day}T${String(e.hour).padStart(2, "0")}:00:00`).toISOString() : null;
  return {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago", source: query.source, bucket,
    bounds: { first_played_at: eventTime(events[0]), last_played_at: eventTime(events.at(-1)), events: events.length },
    available: { spotify: true, youtube: true, jukebox: true, sj: true, lp: true },
    totals: { ...split(filtered), artists: new Set(filtered.map(e => DEMO_TRACKS[e.track].artist)).size, tracks: new Set(filtered.map(e => e.track)).size,
      albums: new Set(filtered.map(e => DEMO_TRACKS[e.track].album)).size, first_played_at: eventTime(filtered[0]), last_played_at: eventTime(filtered.at(-1)),
      skipped: 0, active_days: new Set(filtered.map(e => e.day)).size },
    series: group(filtered, e => bucketDay(e.day, bucket), (bucket_start, es) => ({ bucket_start, ...split(es) })),
    calendar: group(filtered, e => e.day, (day, es) => ({ day, ...split(es) })),
    topArtists: byArtist(dates.filter(e => selectionIncludes(query.trackSel, demoTrackKey(DEMO_TRACKS[e.track])))),
    topTracks: byTrack(dates.filter(e => selectionIncludes(query.artistSel, DEMO_TRACKS[e.track].artist))),
    byHourDow: group(filtered, e => `${e.dow}:${e.hour}`, (key, es) => { const [dow, hour] = key.split(":").map(Number); return { dow, hour, ...split(es) }; }),
    artistOptions: byArtist(dates), trackOptions: byTrack(dates),
    favoriteArtists: byArtist(hearts).map(row => ({ artist: row.artist, favorite_score: row.events, reactions: row.events, songs: row.tracks })),
    favoriteTracks: byTrack(hearts).map(row => ({ key: row.key, artist: row.artist, title: row.title, favorite_score: row.events, reactions: row.events })),
    favoritePlaylists: playlistTracks.map((tracks, i) => ({ id: `demo-playlist-${i}`, name: ["Evening Drive", "Slow Sunday", "Harbor Signal essentials"][i],
      favorite_score: hearts.filter(e => tracks.includes(e.track)).length, reactions: hearts.filter(e => tracks.includes(e.track)).length,
      songs: tracks.length, trackKeys: tracks.map(index => demoTrackKey(DEMO_TRACKS[index])) })),
  };
}
