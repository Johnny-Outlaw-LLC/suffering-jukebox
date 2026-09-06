"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./analytics.module.css";

/* The download is fetched rather than linked, because the export route is
   authorised by a bearer token and a plain <a download> cannot send a header.
   The file is then handed to the browser as a blob, which is also why the
   file name is chosen here rather than read off Content-Disposition. */

type Dataset = "music" | "playlists" | "songs" | "history";
type Format = "csv" | "json";
type Background = "any" | "yes" | "no";

type Filters = { artists: string[]; playlists: string[]; background: Background };

const NO_FILTERS: Filters = { artists: [], playlists: [], background: "any" };

const FILES: Array<{ dataset: Dataset; name: string; file: string; note: string }> = [
  {
    dataset: "music",
    name: "My Music",
    file: "my-music",
    note: "Every song under an artist or album you imported into the Jukebox, with its YouTube link, view count, artist channel, album playlist and whether it plays with the screen off.",
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

const BACKGROUND_CHOICES: Array<{ value: Background; label: string; title: string }> = [
  { value: "any", label: "Any", title: "Every song, however it plays" },
  { value: "yes", label: "Only with", title: "Only songs that play with the screen off" },
  { value: "no", label: "Only without", title: "Only songs that need the screen on" },
];

function fold(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/* A checkbox list behind a button rather than a <select multiple>: an account
   with a few hundred artists is unusable as a scrolling list, and a select is
   as wide as its longest option, which drags a phone sideways. */
function NamePicker({
  label, empty, options, chosen, onChange, allowTyped, hint, disabled,
}: {
  label: string;
  empty: string;
  options: string[];
  chosen: string[];
  onChange: (next: string[]) => void;
  allowTyped: boolean;
  hint?: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function away(event: MouseEvent) {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const chosenKeys = useMemo(() => new Set(chosen.map(fold)), [chosen]);
  const needle = fold(search);
  // Anything already ticked stays on screen, so a choice that scrolled out of
  // a search can still be unticked.
  const shown = useMemo(() => {
    const matches = needle ? options.filter(name => fold(name).includes(needle)) : options;
    const missing = chosen.filter(name => !matches.some(option => fold(option) === fold(name)));
    return [...missing, ...matches].slice(0, 300);
  }, [options, needle, chosen]);

  const typed = search.trim();
  const canAddTyped = allowTyped && !!typed
    && !chosenKeys.has(fold(typed))
    && !options.some(option => fold(option) === fold(typed));

  function toggle(name: string) {
    const key = fold(name);
    onChange(chosenKeys.has(key) ? chosen.filter(item => fold(item) !== key) : [...chosen, name]);
  }

  const summary = chosen.length === 0
    ? empty
    : chosen.length === 1 ? chosen[0] : `${chosen.length} chosen`;

  return <div className={styles.filterPicker} ref={wrap}>
    <span className={styles.filterLabel}>{label}</span>
    <button
      type="button"
      className={`${styles.secondaryButton} ${chosen.length ? styles.activeTab : ""}`}
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(value => !value)}
    >{summary} <span aria-hidden="true">▾</span></button>
    {open && <div className={styles.filterPop}>
      <input
        className={styles.filterSearch}
        placeholder={`Search ${label.toLowerCase()}`}
        value={search}
        autoFocus
        onChange={event => setSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && canAddTyped) { toggle(typed); setSearch(""); }
        }}
      />
      <div className={styles.filterOptions}>
        {canAddTyped && <button
          type="button"
          className={styles.filterAdd}
          onClick={() => { toggle(typed); setSearch(""); }}
        >Use &ldquo;{typed}&rdquo;</button>}
        {shown.map(name => <label key={name} className={styles.filterOption}>
          <input type="checkbox" checked={chosenKeys.has(fold(name))} onChange={() => toggle(name)} />
          <span>{name}</span>
        </label>)}
        {!shown.length && !canAddTyped && <p className={styles.filterNone}>Nothing to choose from yet.</p>}
      </div>
      {(hint || chosen.length > 0) && <div className={styles.filterPopFoot}>
        {hint && <small>{hint}</small>}
        {chosen.length > 0 && <button type="button" className={styles.filterClear} onClick={() => onChange([])}>Clear</button>}
      </div>}
    </div>}
  </div>;
}

export default function DownloadData({ accessToken }: { accessToken: string }) {
  const [format, setFormat] = useState<Format>("csv");
  const [busy, setBusy] = useState<Dataset | "all" | "">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<Set<Dataset>>(new Set());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [options, setOptions] = useState<{ artists: string[]; playlists: string[] }>({ artists: [], playlists: [] });

  const filtered = filters.artists.length > 0 || filters.playlists.length > 0 || filters.background !== "any";
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = filtered ? "-filtered" : "";

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch("/api/my-data/export", { headers: { Authorization: `Bearer ${accessToken}` } });
        const json = await response.json().catch(() => ({}));
        // A picker that will not load is not worth an error message above the
        // downloads: the files still build, unfiltered, which is what they did
        // before there were filters at all.
        if (live && json?.ok) setOptions({ artists: json.artists || [], playlists: json.playlists || [] });
      } catch { /* leave the pickers empty */ }
    })();
    return () => { live = false; };
  }, [accessToken]);

  async function download(dataset: Dataset, fileBase: string) {
    const response = await fetch("/api/my-data/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ dataset, format, filters }),
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(json.error || "Could not build that download.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `suffering-jukebox-${fileBase}-${stamp}${suffix}.${format}`;
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
        <p>Take your music, your playlists, your songs and your listening history with you. Every file carries a YouTube link on each row, so a song is still playable long after it leaves this site, and a Background Audio column saying whether that song still plays with the screen off. Nothing is deleted by downloading it.</p>
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

    <div className={styles.filterBar} role="group" aria-label="Narrow what goes in the files">
      <NamePicker
        label="Artist"
        empty="All artists"
        options={options.artists}
        chosen={filters.artists}
        allowTyped
        hint="An artist you only ever played on Spotify can be typed in."
        disabled={!!busy}
        onChange={artists => setFilters(current => ({ ...current, artists }))}
      />
      <NamePicker
        label="Playlist"
        empty="All playlists"
        options={options.playlists}
        chosen={filters.playlists}
        allowTyped={false}
        hint="Narrows My Playlists only."
        disabled={!!busy}
        onChange={playlists => setFilters(current => ({ ...current, playlists }))}
      />
      <div className={styles.filterPicker}>
        <span className={styles.filterLabel}>Background audio</span>
        <div className={styles.filterToggle}>
          {BACKGROUND_CHOICES.map(choice => <button
            key={choice.value}
            type="button"
            title={choice.title}
            disabled={!!busy}
            className={`${styles.secondaryButton} ${filters.background === choice.value ? styles.activeTab : ""}`}
            onClick={() => setFilters(current => ({ ...current, background: choice.value }))}
          >{choice.label}</button>)}
        </div>
      </div>
      {filtered && <button
        type="button"
        className={styles.filterReset}
        disabled={!!busy}
        onClick={() => setFilters(NO_FILTERS)}
      >Clear filters</button>}
    </div>

    <div className={styles.dataBatchList}>
      {FILES.map(item => <div className={styles.downloadRow} key={item.dataset}>
        <div>
          <strong>{item.name}</strong>
          <small>{item.note}</small>
          <code>suffering-jukebox-{item.file}-{stamp}{suffix}.{format}</code>
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
      <span>Choose JSON instead if you are feeding this to another program. A long listening history can take a moment to build, and your browser may ask permission before saving several files at once.{filtered ? " A filtered file is saved with -filtered in its name, so it cannot be mistaken for the whole thing." : ""}</span>
    </div>
  </section>;
}
