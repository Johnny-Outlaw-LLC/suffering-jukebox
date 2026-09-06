"use client";

import { useState } from "react";
import styles from "./analytics.module.css";

/* The download is fetched rather than linked, because the export route is
   authorised by a bearer token and a plain <a download> cannot send a header.
   The file is then handed to the browser as a blob, which is also why the
   file name is chosen here rather than read off Content-Disposition. */

type Dataset = "music" | "playlists" | "songs" | "history";
type Format = "csv" | "json";

const FILES: Array<{ dataset: Dataset; name: string; file: string; note: string }> = [
  {
    dataset: "music",
    name: "My Music",
    file: "my-music",
    note: "Every song under an artist or album you imported into the Jukebox, with its YouTube link, view count, artist channel and album playlist.",
  },
  {
    dataset: "playlists",
    name: "My Playlists",
    file: "my-playlists",
    note: "Every playlist you own, one row per song in playing order, with who added it and its YouTube link.",
  },
  {
    dataset: "songs",
    name: "My Songs",
    file: "my-songs",
    note: "Every song in your My Jukebox library, with where it came from, your rating and its YouTube link.",
  },
  {
    dataset: "history",
    name: "My Listening History",
    file: "my-listening-history",
    note: "Every play in the Jukebox plus any Spotify or YouTube history you imported, with a YouTube link wherever we know the video.",
  },
];

export default function DownloadData({ accessToken }: { accessToken: string }) {
  const [format, setFormat] = useState<Format>("csv");
  const [busy, setBusy] = useState<Dataset | "all" | "">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<Set<Dataset>>(new Set());

  async function download(dataset: Dataset, fileBase: string) {
    const response = await fetch("/api/my-data/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ dataset, format }),
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json.error || "Could not build that download.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `suffering-jukebox-${fileBase}-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking straight away can cancel the save in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setDone(current => new Set(current).add(dataset));
  }

  async function run(dataset: Dataset, fileBase: string) {
    if (busy) return;
    setBusy(dataset); setError("");
    try { await download(dataset, fileBase); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not build that download."); }
    finally { setBusy(""); }
  }

  async function runAll() {
    if (busy) return;
    setBusy("all"); setError("");
    try {
      // One at a time: four exports at once would page the catalogue four
      // times over and a browser blocks a burst of saves anyway.
      for (const item of FILES) await download(item.dataset, item.file);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not build that download.");
    } finally { setBusy(""); }
  }

  return <section className={styles.dataManager} aria-labelledby="download-my-data-title">
    <div className={styles.dataManagerIntro}>
      <div>
        <p className={styles.eyebrow}>Your data, in a file</p>
        <h2 id="download-my-data-title">Download my data</h2>
        <p>Take your music, your playlists, your songs and your listening history with you. Every file carries a YouTube link on each row, so a song is still playable long after it leaves this site. Nothing is deleted by downloading it.</p>
      </div>
      <div className={styles.formatChoice} role="group" aria-label="File format">
        <span>Format</span>
        <div>
          <button className={`${styles.secondaryButton} ${format === "csv" ? styles.activeTab : ""}`} onClick={() => setFormat("csv")} disabled={!!busy}>CSV</button>
          <button className={`${styles.secondaryButton} ${format === "json" ? styles.activeTab : ""}`} onClick={() => setFormat("json")} disabled={!!busy}>JSON</button>
        </div>
      </div>
    </div>

    {error && <div className={styles.error}>{error}</div>}

    <div className={styles.dataBatchList}>
      {FILES.map(item => <div className={styles.downloadRow} key={item.dataset}>
        <div>
          <strong>{item.name}</strong>
          <small>{item.note}</small>
          <code>suffering-jukebox-{item.file}-{new Date().toISOString().slice(0, 10)}.{format}</code>
        </div>
        <button
          className={styles.secondaryButton}
          disabled={!!busy}
          onClick={() => void run(item.dataset, item.file)}
        >{busy === item.dataset ? "Preparing…" : done.has(item.dataset) ? "Download again" : "Download"}</button>
      </div>)}
    </div>

    <div className={styles.dataActions}>
      <button className={styles.primaryButton} disabled={!!busy} onClick={() => void runAll()}>
        {busy === "all" ? "Preparing all four files…" : "Download all four files"}
      </button>
    </div>

    <div className={styles.retentionNotice}>
      <strong>CSV opens in a spreadsheet</strong>
      <span>Choose JSON instead if you are feeding this to another program. A long listening history can take a moment to build, and your browser may ask permission before saving several files at once.</span>
    </div>
  </section>;
}
