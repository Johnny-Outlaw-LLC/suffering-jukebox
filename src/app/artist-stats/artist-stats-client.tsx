"use client";

import { useCallback, useEffect, useState } from "react";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";
import type { PublicSurface } from "@/lib/surface";
import { useJukeboxSession } from "@/lib/use-jukebox-session";
import { StatsDashboard, type Stats } from "./stats-dashboard";
export type { Stats } from "./stats-dashboard";
import shell from "../analytics/analytics.module.css";
import styles from "./artist-stats.module.css";

type StatsArtist = Stats["artist"];
const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

export default function ArtistStatsClient({ brand }: { brand: PublicSurface }) {
  const { sessionReady, signedIn, accessToken, fromNativeApp } = useJukeboxSession(brand);
  const [artists, setArtists] = useState<StatsArtist[] | null>(null);
  const [slug, setSlug] = useState("");
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setSlug((q.get("artist") || "").toLowerCase());
    const d = Number(q.get("days"));
    if (RANGES.some((r) => r.days === d)) setDays(d);
  }, []);

  const load = useCallback(async (artistSlug: string, range: number, signal: AbortSignal) => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const qs = new URLSearchParams({ days: String(range), tz });
      if (artistSlug) qs.set("artist", artistSlug);
      const res = await fetch(`/api/artist-stats?${qs}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
      const body = await res.json();
      if (signal.aborted) return;
      setIsAdmin(body.isAdmin === true);
      if (Array.isArray(body.artists)) setArtists(body.artists);
      if (!res.ok || !body.ok) {
        setStats(null);
        setError(body.error || "Could not load stats.");
        return;
      }
      if (body.stats) {
        setStats(body.stats);
        if (body.stats.artist.slug !== artistSlug) setSlug(body.stats.artist.slug);
      }
    } catch {
      if (signal.aborted) return;
      setStats(null);
      setError("Could not load stats. Check your connection and try again.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { setStats(null); setArtists(null); setIsAdmin(false); }, [accessToken]);
  useEffect(() => {
    const controller = new AbortController();
    void load(slug, days, controller.signal);
    return () => controller.abort();
  }, [load, slug, days]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (slug) q.set("artist", slug);
    if (days !== 30) q.set("days", String(days));
    window.history.replaceState(null, "", `/artist-stats${q.size ? `?${q}` : ""}`);
  }, [slug, days]);

  async function signIn() {
    await sjBrowserAuth.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
  }

  const pageStyle = {
    ["--sj-accent" as string]: brand.accent,
    ["--sj-accent-soft" as string]: `rgba(${brand.accentRgb},.14)`,
    ["--sj-accent-rgb" as string]: brand.accentRgb,
    ["--sj-accent-hover" as string]: brand.accentHover,
  };

  const artistUrl = stats?.artist.slug ? `${brand.url}/${stats.artist.slug}` : "";

  return (
    <main className={shell.page} data-surface={brand.id} style={pageStyle}>
      <header className={shell.header}>
        {fromNativeApp
          ? <button type="button" className={shell.backButton} onClick={() => window.history.back()}>‹ Back to {brand.name}</button>
          : <a href={stats?.artist.slug ? `/${stats.artist.slug}` : "/"} className={shell.back}>← Back to {brand.name}</a>}
        <div>
          <p className={shell.eyebrow}>{brand.name} for artists</p>
          <h1>{stats?.artist.name || "Artist"} <span>Stats</span></h1>
        </div>
        {artists && (
          <label className={styles.picker}>
            <span>{isAdmin ? "Artists with stats · admin only" : "Your artists with stats"} · {RANGES.find(r => r.days === days)?.label}</span>
            <select value={artists.some(a => a.slug === slug) ? slug : ""} onChange={(e) => setSlug(e.target.value)}>
              <option value="">All Artists</option>
              {artists.map((a) => <option key={a.id} value={a.slug}>{a.name}</option>)}
            </select>
          </label>
        )}
        {signedIn && artists && <p className={styles.privacyNotice}>{isAdmin ? "Private admin dashboard · Playback metrics across all artists" : "Private artist dashboard · Metrics for your music only"}</p>}
      </header>

      {!sessionReady ? <div className={shell.loading}>Opening your stats…</div> : !signedIn ? (
        <section className={shell.signIn}>
          <p className={shell.eyebrow}>For artists</p>
          <h2>Sign in to see your stats</h2>
          <p>These metrics are private. Artists see only their own music; site admins can see all artists.</p>
          <button className={shell.primaryButton} onClick={() => void signIn()}>Sign in with Google</button>
        </section>
      ) : (
        <div className={`${styles.body} ${loading && stats ? styles.refetching : ""}`}>
          <div className={styles.filters} role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button key={r.days} type="button" aria-pressed={days === r.days}
                className={`${shell.secondaryButton} ${days === r.days ? shell.activeTab : ""}`}
                onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
            {artistUrl && (
              <a className={styles.artistLink} href={artistUrl} target="_blank" rel="noopener noreferrer">
                {artistUrl.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>

          {error && <div className={shell.error}>{error}</div>}
          {artists && !artists.length && !loading && !error && <p className={styles.coverage}>No artists have recorded plays in these {RANGES.find(r => r.days === days)?.label}. Choose a longer date range to see more activity.</p>}
          {!stats && !error && <div className={shell.loading}>Counting plays…</div>}

          {stats && <StatsDashboard stats={stats} brand={brand} />}
        </div>
      )}
    </main>
  );
}
