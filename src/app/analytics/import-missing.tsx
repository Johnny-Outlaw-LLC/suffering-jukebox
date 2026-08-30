"use client";

/* Importing the music your history says you love, without leaving the page.

   This used to be one "Add to Jukebox" link per row, opening the 1.1MB
   dashboard in a new tab with ?import=song so it could prefill a search box.
   That is one tab per song, and a Spotify history import surfaces hundreds.

   The import primitives were never in that HTML file - they are server routes
   (/api/my-jukebox/search, /api/my-jukebox add_youtube, /api/my-jukebox/lyrics).
   So this is the same four-step shape as the Spotify wizard, run natively here
   against those routes: pick many, match once, confirm the matches, commit. */

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./import-missing.module.css";

export type MissingSong = { key: string; title: string; artist: string };

/* A YouTube search costs 100 quota units AND /api/my-jukebox/search is rate
   limited to 20 requests a minute per IP. One pass is therefore 20 songs: it
   fits inside that window exactly, and spends a fifth of the daily quota
   rather than all of it. The panel says so, instead of failing at song 21. */
const MATCH_MAX = 20;

type Match = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnail: string | null;
  views: number | null;
  keep: boolean;
  artist: string;
  track: string;
};

type Tone = "ok" | "err" | undefined;
type LogLine = { text: string; tone: Tone };
type Visibility = "private" | "public";
type Summary = { added: number; duplicate: number; failed: number; lyrics: number };

type Props = {
  accessToken: string;
  songs: MissingSong[];
  initialSelected?: string[];
  onClose: () => void;
  onImported: (added: number) => void;
};

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => count(n) + " " + (n === 1 ? one : many);

function fmtViews(views: number | null) {
  if (views == null) return "";
  if (views >= 1_000_000) return (views / 1_000_000).toFixed(1) + "M views";
  if (views >= 1_000) return Math.round(views / 1_000) + "K views";
  return count(views) + " views";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function ImportMissing({ accessToken, songs, initialSelected, onClose, onImported }: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initialSelected ?? []));
  const [filter, setFilter] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  const logEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => { cancelled.current = true; }, []);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: "nearest" }); }, [log]);

  // Escape closes, but never mid-write: a half-finished import should not be
  // abandoned by a stray keypress.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return songs;
    return songs.filter((s) => (s.artist + " " + s.title).toLowerCase().includes(needle));
  }, [filter, songs]);

  const chosen = useMemo(
    () => songs.filter((s) => picked.has(s.key)).slice(0, MATCH_MAX),
    [picked, songs],
  );
  const keeping = matches.filter((m) => m.keep);

  function say(text: string, tone: Tone = undefined) {
    setLog((lines) => [...lines, { text, tone }]);
  }

  function togglePick(key: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function pickVisible(on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (!on) { visible.forEach((s) => next.delete(s.key)); return next; }
      // Only ever tick up to a full pass, so the footer count and what the
      // matcher will actually do are the same number.
      for (const song of visible) {
        if (next.size >= MATCH_MAX) break;
        next.add(song.key);
      }
      return next;
    });
  }

  /* One request, with the rate limiter respected rather than fought. A 429 on
     the search route means we are inside somebody else's window, so wait it
     out instead of dropping the song on the floor. */
  async function call(path: string, init: RequestInit, retries = 2): Promise<any> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
        ...(init.headers || {}),
      },
    });
    if (response.status === 429 && retries > 0) {
      say("  · busy, waiting a moment");
      await wait(6000);
      return call(path, init, retries - 1);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.ok) throw new Error(json.error || "That did not work.");
    return json;
  }

  async function findMatches() {
    if (!chosen.length) return;
    cancelled.current = false;
    setBusy(true);
    setError("");
    setMatches([]);
    setLog([]);
    setStep(2);
    const found: Match[] = [];
    let missed = 0;
    for (const song of chosen) {
      if (cancelled.current) break;
      say(song.artist + " — " + song.title + "…");
      try {
        const query = encodeURIComponent(song.artist + " " + song.title);
        const result = await call("/api/my-jukebox/search?q=" + query, { method: "GET" });
        const video = (result.results || [])[0];
        if (video) {
          found.push({
            videoId: video.videoId,
            title: video.title,
            channelTitle: video.channelTitle || "",
            thumbnail: video.thumbnail ?? null,
            views: video.views ?? null,
            keep: true,
            artist: song.artist,
            track: song.title,
          });
          say("  ✓ " + String(video.title || "").slice(0, 70), "ok");
        } else {
          missed += 1;
          say("  × nothing playable found", "err");
        }
      } catch (caught) {
        missed += 1;
        say("  × " + ((caught as Error)?.message || "search failed"), "err");
      }
    }
    if (cancelled.current) return;
    setMatches(found);
    setBusy(false);
    say(
      found.length + " of " + chosen.length + " matched" + (missed ? " · " + missed + " not found" : ""),
      found.length ? "ok" : "err",
    );
    if (found.length) setStep(3);
  }

  async function importAll() {
    if (!keeping.length) return;
    cancelled.current = false;
    setBusy(true);
    setError("");
    setLog([]);
    setStep(4);
    let added = 0, duplicate = 0, failed = 0, lyrics = 0;
    const trackIds: string[] = [];
    for (const row of keeping) {
      if (cancelled.current) break;
      const artistName = row.artist.trim();
      const trackName = row.track.trim();
      say((artistName || "Unknown artist") + " — " + (trackName || row.title));
      try {
        const data = await call("/api/my-jukebox", {
          method: "POST",
          body: JSON.stringify({
            action: "add_youtube",
            videoId: row.videoId,
            artistName: artistName || null,
            trackName: trackName || null,
            // Analytics measures how long a song was PLAYED, never how long it
            // is, so there is no running time to hand over here. YouTube's own
            // contentDetails fills it in, and LRCLIB matches on that.
            durationMs: null,
            source: "spotify",
            visibility,
          }),
        });
        if (data.duplicate) { duplicate += 1; say("  · already in your jukebox"); }
        else { added += 1; say("  ✓ added", "ok"); }
        if (data.lyricsFound) { lyrics += 1; say("  ✓ lyrics", "ok"); }
        else if (data.catalogTrackId) say("  · no lyrics on LRCLIB");
        if (data.catalogTrackId) trackIds.push(data.catalogTrackId);
      } catch (caught) {
        failed += 1;
        say("  × " + ((caught as Error)?.message || "could not add"), "err");
      }
    }

    // Second pass for anything that landed without words. Never fatal: a song
    // with no lyrics is still a song.
    if (trackIds.length && !cancelled.current) {
      try {
        const result = await call("/api/my-jukebox/lyrics", {
          method: "POST",
          body: JSON.stringify({ trackIds: trackIds.slice(0, 40) }),
        });
        if (result.found) {
          lyrics += result.found;
          say("✓ found lyrics for " + plural(result.found, "more song", "more songs"), "ok");
        }
      } catch { /* the songs are in; the words are the bonus */ }
    }

    if (cancelled.current) return;
    setBusy(false);
    setSummary({ added, duplicate, failed, lyrics });
    // Tell the dashboard to re-read, so the rows we just imported stop
    // offering to import themselves.
    if (added) onImported(added);
  }

  function startOver() {
    setPicked(new Set());
    setMatches([]);
    setLog([]);
    setSummary(null);
    setFilter("");
    setStep(1);
  }

  const steps: Array<[1 | 2 | 3 | 4, string]> = [
    [1, "Choose songs"],
    [2, "Find them"],
    [3, "Check the matches"],
    [4, "Add them"],
  ];

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label="Import missing songs">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <p className={styles.eyebrow}>From your listening history</p>
            <h2>Import missing songs</h2>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            disabled={busy}
            title={busy ? "Wait for this to finish" : "Close"}
          >
            &times;
          </button>
        </header>

        <ol className={styles.steps}>
          {steps.map(([n, label]) => (
            <li key={n} className={step === n ? styles.stepOn : step > n ? styles.stepDone : ""}>
              <b>{n}</b><span>{label}</span>
            </li>
          ))}
        </ol>

        <div className={styles.body}>
          {error && <p className={styles.error}>{error}</p>}

          {step === 1 && (
            <>
              <p className={styles.lead}>
                These are songs in your listening history that the Jukebox does not have yet.
                Tick the ones you want and we will find each one on YouTube and add them.
              </p>
              <div className={styles.tools}>
                <input
                  className={styles.search}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Search these songs"
                  aria-label="Search missing songs"
                />
                <button type="button" className={styles.ghost} onClick={() => pickVisible(true)}>Select up to {MATCH_MAX}</button>
                <button type="button" className={styles.ghost} onClick={() => pickVisible(false)}>Clear</button>
              </div>
              <div className={styles.list}>
                {visible.map((song) => {
                  const on = picked.has(song.key);
                  const full = !on && picked.size >= MATCH_MAX;
                  return (
                    <label
                      key={song.key}
                      className={styles.row + (on ? " " + styles.rowOn : "") + (full ? " " + styles.rowFull : "")}
                    >
                      <input type="checkbox" checked={on} disabled={full} onChange={() => togglePick(song.key)} />
                      <span className={styles.rowText}>
                        <span className={styles.rowTitle}>{song.title}</span>
                        <span className={styles.rowSub}>{song.artist}</span>
                      </span>
                    </label>
                  );
                })}
                {!visible.length && <p className={styles.empty}>No missing songs match that search.</p>}
              </div>
              <p className={styles.note}>
                Up to {MATCH_MAX} at a time. Each song costs a YouTube search and searches are
                metered, so this runs in passes rather than all at once.
              </p>
            </>
          )}

          {(step === 2 || step === 4) && (
            <div className={styles.log}>
              {log.map((line, n) => (
                <div
                  key={n}
                  className={styles.logLine + (line.tone === "ok" ? " " + styles.logOk : line.tone === "err" ? " " + styles.logErr : "")}
                >
                  {line.text}
                </div>
              ))}
              <div ref={logEnd} />
            </div>
          )}

          {step === 4 && summary && (
            <div className={styles.done}>
              <h3>{summary.added ? "Added " + plural(summary.added, "song", "songs") : "Nothing new was added"}</h3>
              <p>
                {summary.duplicate ? plural(summary.duplicate, "song was", "songs were") + " already in your jukebox. " : ""}
                {summary.lyrics ? "Lyrics found for " + count(summary.lyrics) + ". " : ""}
                {summary.failed ? plural(summary.failed, "song", "songs") + " could not be added." : ""}
              </p>
              <p className={styles.note}>
                {visibility === "private"
                  ? "These are in My Jukebox only. The artist card's own control is how they go public."
                  : "These are in the public catalogue and will show on Explore Artists."}
              </p>
            </div>
          )}

          {step === 3 && (
            <>
              <fieldset className={styles.vis}>
                <legend>Who should see this music?</legend>
                <label className={styles.visOpt}>
                  <input type="radio" name="importVis" checked={visibility === "private"} onChange={() => setVisibility("private")} />
                  <span><b>Import into My Jukebox only</b><em>Only you see it listed. It stays out of Explore Artists and the public grids.</em></span>
                </label>
                <label className={styles.visOpt}>
                  <input type="radio" name="importVis" checked={visibility === "public"} onChange={() => setVisibility("public")} />
                  <span><b>Add to the public catalogue</b><em>Everyone finds it on Explore Artists. Play counts and charts are shared.</em></span>
                </label>
              </fieldset>
              <p className={styles.lead}>Check what we found. The artist and song names here are what get stored.</p>
              <div className={styles.list}>
                {matches.map((match, n) => (
                  <div key={match.videoId + n} className={styles.match + (match.keep ? "" : " " + styles.matchOff)}>
                    <input
                      type="checkbox"
                      checked={match.keep}
                      aria-label={"Add " + match.track}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setMatches((rows) => rows.map((row, i) => (i === n ? { ...row, keep: on } : row)));
                      }}
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt="" src={match.thumbnail || "https://i.ytimg.com/vi/" + match.videoId + "/mqdefault.jpg"} />
                    <span className={styles.matchText}>
                      <span className={styles.rowTitle}>{match.track}</span>
                      <span className={styles.rowSub}>{match.title}</span>
                      <span className={styles.rowSub}>{[match.channelTitle, fmtViews(match.views)].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className={styles.matchEdit}>
                      <label>
                        Artist
                        <input
                          value={match.artist}
                          onChange={(event) => {
                            const value = event.target.value;
                            setMatches((rows) => rows.map((row, i) => (i === n ? { ...row, artist: value } : row)));
                          }}
                        />
                      </label>
                      <label>
                        Song
                        <input
                          value={match.track}
                          onChange={(event) => {
                            const value = event.target.value;
                            setMatches((rows) => rows.map((row, i) => (i === n ? { ...row, track: value } : row)));
                          }}
                        />
                      </label>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className={styles.foot}>
          {step === 1 && (
            <>
              <span>{picked.size ? plural(picked.size, "song", "songs") + " chosen" : "Nothing chosen yet"}</span>
              <button type="button" className={styles.ghost} onClick={onClose}>Cancel</button>
              <button type="button" className={styles.primary} disabled={!chosen.length} onClick={() => void findMatches()}>
                {chosen.length ? "Find matches for " + plural(chosen.length, "song", "songs") : "Find matches"}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <span>{busy ? "Searching YouTube…" : "Finished searching"}</span>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => { cancelled.current = true; setBusy(false); setStep(1); }}
              >
                {busy ? "Stop" : "Back"}
              </button>
              {!busy && !!matches.length && (
                <button type="button" className={styles.primary} onClick={() => setStep(3)}>Check the matches</button>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <span>{keeping.length ? plural(keeping.length, "song", "songs") + " to add" : "Nothing ticked"}</span>
              <button type="button" className={styles.ghost} onClick={() => setStep(1)}>Back</button>
              <button type="button" className={styles.primary} disabled={!keeping.length} onClick={() => void importAll()}>
                Add {plural(keeping.length, "song", "songs")}
              </button>
            </>
          )}
          {step === 4 && (
            <>
              <span>{busy ? "Adding to your jukebox…" : "Done"}</span>
              {busy ? (
                <button type="button" className={styles.ghost} onClick={() => { cancelled.current = true; setBusy(false); }}>Stop</button>
              ) : (
                <>
                  <button type="button" className={styles.ghost} onClick={startOver}>Import more</button>
                  <button type="button" className={styles.primary} onClick={onClose}>Close</button>
                </>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
