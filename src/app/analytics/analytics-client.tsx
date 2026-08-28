"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";
import AnalyticsDashboard from "./analytics-dashboard";
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

function eventIdentity(event: HistoryEvent) {
  return [event.contentType, event.uri || "", event.playedAt, event.durationMs, event.title, event.artist, event.album].join("\0");
}

function Wizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [includedEventIndexes, setIncludedEventIndexes] = useState<Set<number>>(new Set());
  const [files, setFiles] = useState<FileProgress[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ done: 0, total: 0 });
  const [saved, setSaved] = useState<{ inserted: number; skipped: number } | null>(null);
  const [artistSearch, setArtistSearch] = useState("");
  const IMPORT_BATCH = 1000;

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
      byArtist.set(event.artist, (byArtist.get(event.artist) || 0) + 1);
    }
    return {
      byType,
      byYear: [...byYear.entries()].sort(([a], [b]) => b.localeCompare(a)),
      artists: [...byArtist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      durationMs,
    };
  }, [events]);

  const selectedEvents = useMemo(() => events.filter((_, index) => includedEventIndexes.has(index)), [events, includedEventIndexes]);
  const selectedDurationMs = useMemo(() => selectedEvents.reduce((total, event) => total + event.durationMs, 0), [selectedEvents]);
  const indexesForType = useMemo(() => {
    const indexes: Record<ContentType, number[]> = { music: [], podcast: [], audiobook: [], other: [] };
    events.forEach((event, index) => indexes[event.contentType].push(index));
    return indexes;
  }, [events]);
  const indexesForYear = useMemo(() => {
    const indexes = new Map<string, number[]>();
    events.forEach((event, index) => {
      const year = String(new Date(event.playedAt).getFullYear());
      indexes.set(year, [...(indexes.get(year) || []), index]);
    });
    return indexes;
  }, [events]);
  const indexesForArtist = useMemo(() => {
    const indexes = new Map<string, number[]>();
    events.forEach((event, index) => indexes.set(event.artist, [...(indexes.get(event.artist) || []), index]));
    return indexes;
  }, [events]);
  const visibleArtists = useMemo(() => {
    const query = artistSearch.trim().toLocaleLowerCase();
    return query ? summary.artists.filter(([artist]) => artist.toLocaleLowerCase().includes(query)) : summary.artists;
  }, [artistSearch, summary.artists]);

  function selectedIn(indexes: number[]) { return indexes.reduce((total, index) => total + (includedEventIndexes.has(index) ? 1 : 0), 0); }
  function isAllSelected(indexes: number[]) { return indexes.length > 0 && indexes.every(index => includedEventIndexes.has(index)); }
  function isPartlySelected(indexes: number[]) { const selected = selectedIn(indexes); return selected > 0 && selected < indexes.length; }
  function toggleIndexes(indexes: number[]) {
    setIncludedEventIndexes(current => {
      const next = new Set(current);
      if (indexes.length > 0 && indexes.every(index => current.has(index))) indexes.forEach(index => next.delete(index));
      else indexes.forEach(index => next.add(index));
      return next;
    });
  }

  async function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files || []).filter(file => /\.json$/i.test(file.name));
    if (!chosen.length) { setError("Choose one or more JSON files from your Spotify export."); return; }
    setError(""); setSaved(null); setEvents([]); setIncludedEventIndexes(new Set()); setArtistSearch(""); setStep(2);
    let progress: FileProgress[] = chosen.map(file => ({ name: file.name, rows: 0, accepted: 0, state: "waiting" }));
    setFiles(progress);
    const nextEvents: HistoryEvent[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < chosen.length; index += 1) {
      const file = chosen[index];
      progress = progress.map((item, itemIndex) => itemIndex === index ? { ...item, state: "reading" } : item);
      setFiles(progress);
      try {
        const raw = JSON.parse(await file.text());
        if (!Array.isArray(raw)) throw new Error("not a Spotify history array");
        let accepted = 0;
        for (const row of raw) {
          const event = normalizeRow(row as Record<string, unknown>, file.name);
          if (!event) continue;
          const key = eventIdentity(event);
          if (seen.has(key)) continue;
          seen.add(key);
          nextEvents.push(event);
          accepted += 1;
        }
        progress = progress.map((item, itemIndex) => itemIndex === index ? { ...item, rows: raw.length, accepted, state: "done" } : item);
      } catch (caught) {
        progress = progress.map((item, itemIndex) => itemIndex === index ? { ...item, state: "error", error: caught instanceof Error ? caught.message : "could not read file" } : item);
      }
      setFiles(progress);
    }
    setEvents(nextEvents);
    setIncludedEventIndexes(new Set(nextEvents.map((_, index) => index)));
    if (!nextEvents.length) { setError("None of those files contained usable Spotify history rows."); return; }
    setStep(3);
  }

  async function postHistoryBatch(accessToken: string, batch: HistoryEvent[], attempt = 0): Promise<{ inserted: number; skipped: number }> {
    const response = await fetch("/api/spotify/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: "import-history", events: batch }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 6) {
      const waitMs = Math.min(30_000, 1500 * (2 ** attempt));
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return postHistoryBatch(accessToken, batch, attempt + 1);
    }
    if (!response.ok || !data.ok) throw new Error(data.error || "Could not save this batch.");
    return { inserted: Number(data.inserted || 0), skipped: Number(data.skipped || 0) };
  }

  async function confirmImport() {
    if (!selectedEvents.length || saving) return;
    setSaving(true); setError("");
    setSaveProgress({ done: 0, total: selectedEvents.length });
    let inserted = 0; let skipped = 0;
    try {
      const { data: { session } } = await sjBrowserAuth.auth.getSession();
      if (!session?.access_token) throw new Error("Sign in to save your Spotify history.");
      for (let index = 0; index < selectedEvents.length; index += IMPORT_BATCH) {
        const batch = selectedEvents.slice(index, index + IMPORT_BATCH);
        const result = await postHistoryBatch(session.access_token, batch);
        inserted += result.inserted;
        skipped += result.skipped;
        setSaveProgress({ done: Math.min(selectedEvents.length, index + batch.length), total: selectedEvents.length });
      }
      setSaved({ inserted, skipped });
      onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import this history.");
    } finally { setSaving(false); }
  }

  function reset() { setStep(1); setEvents([]); setIncludedEventIndexes(new Set()); setFiles([]); setError(""); setSaved(null); setArtistSearch(""); }
  const completedFiles = files.filter(file => file.state === "done").length;
  const topYearCount = Math.max(...summary.byYear.map(([, count]) => count), 1);

  return <section className={styles.wizard} aria-label="Spotify history import">
    <div className={styles.stepper}>{["Upload", "Process", "Review", "Confirm"].map((label, index) => <div className={`${styles.step} ${step === index + 1 ? styles.stepActive : ""} ${step > index + 1 ? styles.stepDone : ""}`} key={label}><span>{index + 1}</span>{label}</div>)}</div>
    {error && <div className={styles.error}>{error}</div>}

    {step === 1 && <div className={styles.stepBody}>
      <p className={styles.lead}>Upload every JSON file from your Spotify Extended Streaming History export. We strip IP-address fields before anything can be saved.</p>
      <label className={styles.dropZone}><input type="file" multiple accept=".json,application/json" onChange={onFilesChosen} /><strong>Choose Spotify history JSON files</strong><span>You can select or drop multiple files at once.</span></label>
      <section className={styles.spotifyHowTo} aria-labelledby="spotify-history-how-to">
        <p className={styles.eyebrow}>Need your files first?</p>
        <h2 id="spotify-history-how-to">How to get your Spotify history</h2>
        <ol>
          <li>Open Spotify&apos;s <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noopener noreferrer">Account Privacy</a> page and choose <b>Download your data</b>.</li>
          <li>Request <b>Extended Streaming History</b>—not just the recent streaming-history download.</li>
          <li>When Spotify emails your download, unzip it and upload every history <code>.json</code> file here.</li>
        </ol>
        <p>Spotify prepares the download separately, so it may not arrive immediately. We use the listening records only for your private Analytics, and remove IP-address fields before saving.</p>
      </section>
    </div>}

    {step === 2 && <div className={styles.stepBody}>
      <h2>Processing your files</h2><p className={styles.muted}>{completedFiles} of {files.length} files read · {number(events.length)} usable rows found so far</p>
      <div className={styles.fileList}>{files.map(file => <div className={styles.fileRow} key={file.name}><span>{file.state === "done" ? "✓" : file.state === "error" ? "!" : "…"}</span><div><strong>{file.name}</strong><small>{file.state === "done" ? `${number(file.rows)} rows · ${number(file.accepted)} usable` : file.state === "error" ? file.error : "Reading…"}</small></div></div>)}</div>
    </div>}

    {step === 3 && <div className={styles.stepBody}>
      <div className={styles.reviewHeader}><div><p className={styles.eyebrow}>Review and choose</p><h2>Your Spotify listening history</h2><p className={styles.muted}>{number(selectedEvents.length)} of {number(events.length)} listening events selected · {minutes(selectedDurationMs)} to import</p></div><button className={styles.secondaryButton} onClick={reset}>Start over</button></div>
      <div className={styles.filterToolbar}><p>Uncheck anything you do not want in your private Analytics. Selections combine, so removing a year and an artist leaves both out.</p><div><button className={styles.secondaryButton} onClick={() => setIncludedEventIndexes(new Set(events.map((_, index) => index)))}>Select all</button><button className={styles.secondaryButton} onClick={() => setIncludedEventIndexes(new Set())}>Clear all</button></div></div>
      <div className={styles.typeGrid}>{(Object.keys(TYPE_LABEL) as ContentType[]).map(type => {
        const indexes = indexesForType[type];
        const selected = selectedIn(indexes);
        return <label className={styles.statCard} key={type}>
          <input className={styles.selectionCheckbox} type="checkbox" checked={isAllSelected(indexes)} ref={node => { if (node) node.indeterminate = isPartlySelected(indexes); }} onChange={() => toggleIndexes(indexes)} />
          <span>{TYPE_LABEL[type]}</span><strong>{number(selected)} <small>/ {number(indexes.length)}</small></strong><em>{selected === indexes.length ? "Included" : `${number(selected)} selected`}</em>
        </label>;
      })}</div>
      <div className={styles.reviewGrid}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}><h3>Listening by year</h3><span>{number(summary.byYear.length)} years</span></div>
          <div className={styles.selectionList}>{summary.byYear.map(([year, count]) => {
            const indexes = indexesForYear.get(year) || [];
            const selected = selectedIn(indexes);
            return <label className={styles.barRow} key={year}><input className={styles.selectionCheckbox} type="checkbox" checked={isAllSelected(indexes)} ref={node => { if (node) node.indeterminate = isPartlySelected(indexes); }} onChange={() => toggleIndexes(indexes)} /><span>{year}</span><i><b style={{ width: `${Math.max(3, Math.round((count / topYearCount) * 100))}%` }} /></i><em>{number(selected)} / {number(count)}</em></label>;
          })}</div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHeader}><h3>Artists</h3><span>{number(summary.artists.length)} artists</span></div>
          <input className={styles.artistSearch} type="search" value={artistSearch} onChange={event => setArtistSearch(event.target.value)} placeholder="Search artists" aria-label="Search artists" />
          <div className={styles.selectionList}>{visibleArtists.map(([artist, count]) => {
            const indexes = indexesForArtist.get(artist) || [];
            const selected = selectedIn(indexes);
            return <label className={styles.artistRow} key={artist}><input className={styles.selectionCheckbox} type="checkbox" checked={isAllSelected(indexes)} ref={node => { if (node) node.indeterminate = isPartlySelected(indexes); }} onChange={() => toggleIndexes(indexes)} /><span>{artist}</span><strong>{number(selected)} / {number(count)}</strong></label>;
          })}{!visibleArtists.length && <p className={styles.emptyState}>No artists match that search.</p>}</div>
        </div>
      </div>
      <div className={styles.actions}><button className={styles.secondaryButton} onClick={() => setStep(1)}>Back</button><button className={styles.primaryButton} disabled={!selectedEvents.length} onClick={() => setStep(4)}>{selectedEvents.length ? `Continue with ${number(selectedEvents.length)} events` : "Select events to continue"}</button></div>
    </div>}

    {step === 4 && <div className={styles.stepBody}>
      {saved ? <div className={styles.success}><h2>Spotify history imported</h2><p>{number(saved.inserted)} new listening events saved{saved.skipped ? ` · ${number(saved.skipped)} already on file and skipped` : ""}.</p><p className={styles.muted}>Re-importing the same export is safe — only missing listens are added.</p><button className={styles.primaryButton} onClick={reset}>Import another export</button></div> : <><p className={styles.eyebrow}>Final confirmation</p><h2>Save this listening history?</h2><p className={styles.lead}>This saves {number(selectedEvents.length)} of {number(events.length)} private listening events for your Analytics. It does not add music to the public Jukebox or your My Jukebox library. You can explore missing music separately later.</p><p className={styles.muted}>Safe to re-run the same files: listens you already imported are skipped, and only what is still missing gets saved.</p><div className={styles.confirmation}><span>Files</span><strong>{files.length}</strong><span>Events to save</span><strong>{number(selectedEvents.length)}</strong><span>Data left out</span><strong>{number(events.length - selectedEvents.length)}</strong><span>Data saved</span><strong>Music, podcasts, audiobooks, and other listening events — never IP addresses</strong></div>{saving && saveProgress.total > 0 && <p className={styles.muted}>Saving {number(saveProgress.done)} of {number(saveProgress.total)} events… Large exports take a couple of minutes.</p>}<div className={styles.actions}><button className={styles.secondaryButton} disabled={saving} onClick={() => setStep(3)}>Back</button><button className={styles.primaryButton} disabled={saving} onClick={confirmImport}>{saving ? (saveProgress.total ? `Saving ${number(saveProgress.done)} / ${number(saveProgress.total)}…` : "Saving your history…") : `Import ${number(selectedEvents.length)} events`}</button></div></>}
    </div>}
  </section>;
}

export default function AnalyticsClient() {
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [view, setView] = useState<"dashboard" | "import">("dashboard");
  const [dashKey, setDashKey] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function applySession(session: Session | null) {
      if (!active) return;
      setSignedIn(!!session?.user);
      setAccessToken(session?.access_token || "");
      setSessionReady(true);
    }
    const receiveSession = async (event: MessageEvent) => {
      if (event.source !== window.opener || !isTrustedPlayerOrigin(event.origin)) return;
      if (event.data?.type !== ANALYTICS_SESSION_DELIVERY) return;
      const nextAccess = String(event.data.accessToken || "");
      const refreshToken = String(event.data.refreshToken || "");
      if (!nextAccess || !refreshToken) return;
      const { data, error } = await sjBrowserAuth.auth.setSession({ access_token: nextAccess, refresh_token: refreshToken });
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
  }, []);

  async function signIn() { await sjBrowserAuth.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/analytics` } }); }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← Back to Jukebox</a>
        <div>
          <p className={styles.eyebrow}>Suffering Jukebox</p>
          <h1>My Data <span>&amp; Analytics</span></h1>
        </div>
        {sessionReady && signedIn && (
          <button className={styles.secondaryButton} onClick={() => setView(view === "import" ? "dashboard" : "import")}>
            {view === "import" ? "Back to Analytics" : "Import Spotify history"}
          </button>
        )}
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
          {error && <div className={styles.error}>{error}</div>}
          {view === "import" ? (
            <Wizard onComplete={() => { setDashKey((k) => k + 1); setView("dashboard"); setError(""); }} />
          ) : accessToken ? (
            <AnalyticsDashboard
              key={dashKey}
              accessToken={accessToken}
              onNeedImport={() => setView("import")}
            />
          ) : (
            <div className={styles.loading}>Preparing your session…</div>
          )}
        </>
      )}
    </main>
  );
}
