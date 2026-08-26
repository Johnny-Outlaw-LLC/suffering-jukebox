"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";
import styles from "./analytics.module.css";

type ContentType = "music" | "podcast" | "audiobook" | "other";
type HistoryEvent = {
  contentType: ContentType;
  uri: string | null;
  title: string;
  artist: string;
  album: string;
  playedAt: string;
  durationMs: number;
  skipped: boolean;
  fileName: string;
};
type FileProgress = { name: string; rows: number; accepted: number; state: "waiting" | "reading" | "done" | "error"; error?: string };
type DashboardPlay = { artist?: string; track?: string; played_at?: string; duration_played_ms?: number; source?: string };
type Dashboard = { plays?: DashboardPlay[] };
type SpotifySummary = {
  events?: number;
  durationMs?: number;
  firstPlayedAt?: string | null;
  lastPlayedAt?: string | null;
  byType?: Partial<Record<ContentType, number>>;
  byYear?: Array<{ year: number; events: number }>;
  topArtists?: Array<{ artist: string; events: number }>;
};

const TYPE_LABEL: Record<ContentType, string> = {
  music: "Music",
  podcast: "Podcast",
  audiobook: "Audiobook",
  other: "Other",
};
const ANALYTICS_SESSION_REQUEST = "sj:analytics-session-request";
const ANALYTICS_SESSION_DELIVERY = "sj:analytics-session-delivery";

function isTrustedPlayerOrigin(origin: string) {
  return origin === window.location.origin
    || origin === "https://sufferingjukebox.stream"
    || origin === "https://www.sufferingjukebox.stream";
}

function number(value: number) { return new Intl.NumberFormat().format(value); }
function minutes(value: number) {
  const total = Math.max(0, Math.round(value / 60000));
  const hours = Math.floor(total / 60);
  return hours ? `${hours}h ${total % 60}m` : `${total}m`;
}
function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function normalizeRow(row: Record<string, unknown>, fileName: string): HistoryEvent | null {
  if (!row || typeof row !== "object") return null;
  const trackUri = String(row.spotify_track_uri || "").trim();
  const episodeUri = String(row.spotify_episode_uri || "").trim();
  const audiobookUri = String(row.audiobook_uri || "").trim();
  const contentType: ContentType = trackUri
    ? "music"
    : audiobookUri || row.audiobook_title || row.audiobook_name
      ? "audiobook"
      : episodeUri || row.episode_name || row.episode_show_name
        ? "podcast"
        : "other";
  const playedAt = String(row.ts || row.endTime || "").trim();
  if (!playedAt || Number.isNaN(new Date(playedAt).getTime())) return null;
  const title = String(
    row.master_metadata_track_name || row.episode_name || row.audiobook_title || row.audiobook_name || "Unknown title",
  ).trim() || "Unknown title";
  const artist = String(
    row.master_metadata_album_artist_name || row.episode_show_name || row.audiobook_author_name || "Unknown artist",
  ).trim() || "Unknown artist";
  const album = String(
    row.master_metadata_album_album_name || row.episode_show_name || row.audiobook_name || "",
  ).trim();
  return {
    contentType,
    uri: trackUri || episodeUri || audiobookUri || null,
    title,
    artist,
    album,
    playedAt,
    durationMs: Math.max(0, Number(row.ms_played || 0) || 0),
    skipped: Boolean(row.skipped),
    fileName,
  };
}

function Wizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [files, setFiles] = useState<FileProgress[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ inserted: number; skipped: number } | null>(null);

  const summary = useMemo(() => {
    const byType: Record<ContentType, number> = { music: 0, podcast: 0, audiobook: 0, other: 0 };
    const byYear = new Map<string, number>();
    const byArtist = new Map<string, number>();
    let durationMs = 0;
    for (const event of events) {
      byType[event.contentType] += 1;
      durationMs += event.durationMs;
      const year = String(new Date(event.playedAt).getFullYear());
      byYear.set(year, (byYear.get(year) || 0) + 1);
      if (event.contentType === "music") byArtist.set(event.artist, (byArtist.get(event.artist) || 0) + 1);
    }
    return {
      byType,
      byYear: [...byYear.entries()].sort(([a], [b]) => b.localeCompare(a)),
      topArtists: [...byArtist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12),
      durationMs,
    };
  }, [events]);

  async function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files || []).filter(file => /\.json$/i.test(file.name));
    if (!chosen.length) { setError("Choose one or more JSON files from your Spotify export."); return; }
    setError(""); setSaved(null); setEvents([]); setStep(2);
    let progress: FileProgress[] = chosen.map(file => ({ name: file.name, rows: 0, accepted: 0, state: "waiting" }));
    setFiles(progress);
    const nextEvents: HistoryEvent[] = [];
    for (let index = 0; index < chosen.length; index += 1) {
      const file = chosen[index];
      progress = progress.map((item, itemIndex) => itemIndex === index ? { ...item, state: "reading" } : item);
      setFiles(progress);
      try {
        const raw = JSON.parse(await file.text());
        if (!Array.isArray(raw)) throw new Error("not a Spotify history array");
        const accepted = raw.map(row => normalizeRow(row as Record<string, unknown>, file.name)).filter((row): row is HistoryEvent => !!row);
        nextEvents.push(...accepted);
        progress = progress.map((item, itemIndex) => itemIndex === index ? { ...item, rows: raw.length, accepted: accepted.length, state: "done" } : item);
      } catch (caught) {
        progress = progress.map((item, itemIndex) => itemIndex === index ? { ...item, state: "error", error: caught instanceof Error ? caught.message : "could not read file" } : item);
      }
      setFiles(progress);
    }
    setEvents(nextEvents);
    if (!nextEvents.length) { setError("None of those files contained usable Spotify history rows."); return; }
    setStep(3);
  }

  async function confirmImport() {
    if (!events.length || saving) return;
    setSaving(true); setError("");
    let inserted = 0; let skipped = 0;
    try {
      const { data: { session } } = await sjBrowserAuth.auth.getSession();
      if (!session?.access_token) throw new Error("Sign in to save your Spotify history.");
      for (let index = 0; index < events.length; index += 500) {
        const response = await fetch("/api/spotify/history", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action: "import-history", events: events.slice(index, index + 500) }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not save this batch.");
        inserted += Number(data.inserted || 0); skipped += Number(data.skipped || 0);
      }
      setSaved({ inserted, skipped });
      onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import this history.");
    } finally { setSaving(false); }
  }

  function reset() { setStep(1); setEvents([]); setFiles([]); setError(""); setSaved(null); }
  const completedFiles = files.filter(file => file.state === "done").length;
  const topYearCount = Math.max(...summary.byYear.map(([, count]) => count), 1);

  return <section className={styles.wizard} aria-label="Spotify history import">
    <div className={styles.stepper}>{["Upload", "Process", "Review", "Confirm"].map((label, index) => <div className={`${styles.step} ${step === index + 1 ? styles.stepActive : ""} ${step > index + 1 ? styles.stepDone : ""}`} key={label}><span>{index + 1}</span>{label}</div>)}</div>
    {error && <div className={styles.error}>{error}</div>}

    {step === 1 && <div className={styles.stepBody}>
      <p className={styles.lead}>Upload every JSON file from your Spotify Extended Streaming History export. We strip IP-address fields before anything can be saved.</p>
      <label className={styles.dropZone}><input type="file" multiple accept=".json,application/json" onChange={onFilesChosen} /><strong>Choose Spotify history JSON files</strong><span>You can select or drop multiple files at once.</span></label>
    </div>}

    {step === 2 && <div className={styles.stepBody}>
      <h2>Processing your files</h2><p className={styles.muted}>{completedFiles} of {files.length} files read · {number(events.length)} usable rows found so far</p>
      <div className={styles.fileList}>{files.map(file => <div className={styles.fileRow} key={file.name}><span>{file.state === "done" ? "✓" : file.state === "error" ? "!" : "…"}</span><div><strong>{file.name}</strong><small>{file.state === "done" ? `${number(file.rows)} rows · ${number(file.accepted)} usable` : file.state === "error" ? file.error : "Reading…"}</small></div></div>)}</div>
    </div>}

    {step === 3 && <div className={styles.stepBody}>
      <div className={styles.reviewHeader}><div><p className={styles.eyebrow}>Review results</p><h2>Your Spotify listening history</h2><p className={styles.muted}>{number(events.length)} listening events across {files.length} file{files.length === 1 ? "" : "s"} · {minutes(summary.durationMs)} listened</p></div><button className={styles.secondaryButton} onClick={reset}>Start over</button></div>
      <div className={styles.typeGrid}>{(Object.keys(TYPE_LABEL) as ContentType[]).map(type => <div className={styles.statCard} key={type}><span>{TYPE_LABEL[type]}</span><strong>{number(summary.byType[type])}</strong></div>)}</div>
      <div className={styles.reviewGrid}><div className={styles.panel}><h3>Listening by year</h3>{summary.byYear.map(([year, count]) => <div className={styles.barRow} key={year}><span>{year}</span><i><b style={{ width: `${Math.max(3, Math.round((count / topYearCount) * 100))}%` }} /></i><em>{number(count)}</em></div>)}</div><div className={styles.panel}><h3>Top music artists</h3>{summary.topArtists.map(([artist, count]) => <div className={styles.rankRow} key={artist}><span>{artist}</span><strong>{number(count)}</strong></div>)}</div></div>
      <div className={styles.actions}><button className={styles.secondaryButton} onClick={() => setStep(1)}>Back</button><button className={styles.primaryButton} onClick={() => setStep(4)}>Continue to confirm</button></div>
    </div>}

    {step === 4 && <div className={styles.stepBody}>
      {saved ? <div className={styles.success}><h2>Spotify history imported</h2><p>{number(saved.inserted)} new listening events saved{saved.skipped ? ` · ${number(saved.skipped)} duplicate events skipped` : ""}.</p><button className={styles.primaryButton} onClick={reset}>Import another export</button></div> : <><p className={styles.eyebrow}>Final confirmation</p><h2>Save this listening history?</h2><p className={styles.lead}>This saves {number(events.length)} private listening events for your Analytics. It does not add music to the public Jukebox or your My Jukebox library. You can explore missing music separately later.</p><div className={styles.confirmation}><span>Files</span><strong>{files.length}</strong><span>Events to save</span><strong>{number(events.length)}</strong><span>Data saved</span><strong>Music, podcasts, audiobooks, and other listening events — never IP addresses</strong></div><div className={styles.actions}><button className={styles.secondaryButton} disabled={saving} onClick={() => setStep(3)}>Back</button><button className={styles.primaryButton} disabled={saving} onClick={confirmImport}>{saving ? "Saving your history…" : `Import ${number(events.length)} events`}</button></div></>}
    </div>}
  </section>;
}

export default function AnalyticsClient() {
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [tab, setTab] = useState<"overview" | "spotify">("overview");
  const [days, setDays] = useState(90);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [spotifySummary, setSpotifySummary] = useState<SpotifySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadDashboard(nextDays = days) {
    const { data: { session } } = await sjBrowserAuth.auth.getSession();
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/sj-my-stats?days=${nextDays}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not load your analytics.");
      setDashboard(data.dashboard || {});
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load your analytics."); }
    finally { setLoading(false); }
  }

  async function loadSpotifySummary() {
    const { data: { session } } = await sjBrowserAuth.auth.getSession();
    if (!session?.access_token) return;
    try {
      const response = await fetch("/api/spotify/history", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not load your Spotify history.");
      setSpotifySummary(data.summary || null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your Spotify history.");
    }
  }

  useEffect(() => {
    let active = true;
    async function applySession(session: Session | null) {
      if (!active) return;
      setSignedIn(!!session?.user); setSessionReady(true);
      if (session?.user) { void loadDashboard(); void loadSpotifySummary(); }
    }
    const receiveSession = async (event: MessageEvent) => {
      if (event.source !== window.opener || !isTrustedPlayerOrigin(event.origin)) return;
      if (event.data?.type !== ANALYTICS_SESSION_DELIVERY) return;
      const accessToken = String(event.data.accessToken || "");
      const refreshToken = String(event.data.refreshToken || "");
      if (!accessToken || !refreshToken) return;
      const { data, error } = await sjBrowserAuth.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (!error) {
        await applySession(data.session);
        window.opener = null;
      }
    };
    window.addEventListener("message", receiveSession);
    sjBrowserAuth.auth.getSession().then(({ data: { session } }) => { void applySession(session); });
    const { data: { subscription } } = sjBrowserAuth.auth.onAuthStateChange((_event, session) => { void applySession(session); });
    try {
      const openerOrigin = document.referrer ? new URL(document.referrer).origin : "";
      if (window.opener && isTrustedPlayerOrigin(openerOrigin)) {
        window.opener.postMessage({ type: ANALYTICS_SESSION_REQUEST }, openerOrigin);
      }
    } catch { /* No trusted opener session is available. */ }
    return () => { active = false; window.removeEventListener("message", receiveSession); subscription.unsubscribe(); };
  // loadDashboard deliberately reads the initial default range on route entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plays = dashboard?.plays || [];
  const overview = useMemo(() => {
    const artists = new Map<string, number>(); const tracks = new Map<string, number>();
    let duration = 0;
    for (const play of plays) { artists.set(play.artist || "Unknown Artist", (artists.get(play.artist || "Unknown Artist") || 0) + 1); tracks.set(play.track || "Unknown Track", (tracks.get(play.track || "Unknown Track") || 0) + 1); duration += Number(play.duration_played_ms || 0); }
    return { duration, artists: [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10), tracks: [...tracks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10) };
  }, [plays]);

  async function signIn() { await sjBrowserAuth.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/analytics` } }); }
  function setRange(value: number) { setDays(value); void loadDashboard(value); }

  const ranges: Array<[number, string]> = [[30, "30D"], [90, "90D"], [365, "1Y"], [3650, "All"]];

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← Back to Jukebox</a>
        <div>
          <p className={styles.eyebrow}>Suffering Jukebox</p>
          <h1>My Data <span>&amp; Analytics</span></h1>
        </div>
        {signedIn && <button className={styles.refresh} onClick={() => void loadDashboard()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>}
      </header>

      {!sessionReady ? <div className={styles.loading}>Opening your Analytics…</div> : !signedIn ? (
        <section className={styles.signIn}>
          <p className={styles.eyebrow}>Your listening, privately</p>
          <h2>Sign in to view your Analytics</h2>
          <p>Spotify-history files and listening data stay connected only to your account.</p>
          <button className={styles.primaryButton} onClick={() => void signIn()}>Sign in with Google</button>
        </section>
      ) : (
        <>
          <nav className={styles.tabs} aria-label="Analytics sections">
            <button className={tab === "overview" ? styles.tabActive : ""} onClick={() => setTab("overview")}>Overview</button>
            <button className={tab === "spotify" ? styles.tabActive : ""} onClick={() => setTab("spotify")}>Import Spotify history</button>
          </nav>
          {error && <div className={styles.error}>{error}</div>}
          {tab === "spotify" ? <Wizard onComplete={() => { void loadDashboard(); void loadSpotifySummary(); }} /> : (
            <section className={styles.dashboard}>
              <div className={styles.range} aria-label="Analytics date range">
                {ranges.map(([value, label]) => <button className={days === value ? styles.rangeActive : ""} onClick={() => setRange(value)} key={value}>{label}</button>)}
              </div>
              <div className={styles.kpis}>
                <div><span>Plays</span><strong>{number(plays.length)}</strong></div>
                <div><span>Artists</span><strong>{number(overview.artists.length)}</strong></div>
                <div><span>Tracks</span><strong>{number(overview.tracks.length)}</strong></div>
                <div><span>Listening time</span><strong>{minutes(overview.duration)}</strong></div>
              </div>
              <div className={styles.dashboardGrid}>
                <div className={styles.panel}><h2>Top artists</h2>{overview.artists.map(([artist, count]) => <div className={styles.rankRow} key={artist}><span>{artist}</span><strong>{number(count)}</strong></div>)}</div>
                <div className={styles.panel}><h2>Top tracks</h2>{overview.tracks.map(([track, count]) => <div className={styles.rankRow} key={track}><span>{track}</span><strong>{number(count)}</strong></div>)}</div>
              </div>
              <section className={styles.historySummary}>
                <div>
                  <p className={styles.eyebrow}>Private Spotify history</p>
                  <h2>{spotifySummary?.events ? `${number(spotifySummary.events)} listening events` : "Import your listening history from other platforms"}</h2>
                  {spotifySummary?.events ? <p className={styles.muted}>{minutes(Number(spotifySummary.durationMs || 0))} across {displayDate(spotifySummary.firstPlayedAt || "")} – {displayDate(spotifySummary.lastPlayedAt || "")}. Music, podcasts, audiobooks, and other activity stay separate from your Jukebox library.</p> : <p className={styles.muted}>Your Spotify export is analyzed privately and independently of what Suffering Jukebox carries.</p>}
                </div>
                {spotifySummary?.events ? <div className={styles.historyTypes}>{(Object.keys(TYPE_LABEL) as ContentType[]).map(type => <span key={type}>{TYPE_LABEL[type]} <strong>{number(Number(spotifySummary.byType?.[type] || 0))}</strong></span>)}</div> : null}
              </section>
              {spotifySummary?.events ? <div className={styles.dashboardGrid}>
                <div className={styles.panel}>
                  <h2>Spotify history by year</h2>
                  {(spotifySummary.byYear || []).map(({ year, events }) => <div className={styles.rankRow} key={year}><span>{year}</span><strong>{number(events)}</strong></div>)}
                </div>
                <div className={styles.panel}>
                  <h2>Top Spotify artists</h2>
                  {(spotifySummary.topArtists || []).map(({ artist, events }) => <div className={styles.rankRow} key={artist}><span>{artist}</span><strong>{number(events)}</strong></div>)}
                </div>
              </div> : null}
              <button className={styles.callout} onClick={() => setTab("spotify")}>
                <span>Spotify history</span>
                <strong>Import listening history for deeper analysis →</strong>
              </button>
            </section>
          )}
        </>
      )}
    </main>
  );
}
