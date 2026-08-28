"use client";

// Interactive Jukebox — the guest app.
//
// Lean on purpose: search, browse, add, and pull back your own songs. It is
// not a second copy of the dashboard. Everything it knows comes from
// /api/jukebox/*, so the room's rules are the server's business and this file
// only has to render what it is told.

import { useCallback, useEffect, useRef, useState } from "react";
import Stage, { type Playback } from "./Stage";
import css from "./guest.module.css";

type Settings = {
  maxPendingPerGuest: number;
  allowGuestImports: boolean;
  guestsFirst: boolean;
};

type Room = {
  code: string;
  slug: string | null;
  name: string;
  isLive: boolean;
  settings: Settings;
  playback: Playback;
  /** Songs in the last running order the host broadcast. */
  lastPlaylistCount: number;
};
type Guest = {
  id: string;
  /** Their own name, or "Listener 4" until they pick one. */
  displayName: string;
  /** False while the room is still just numbering them. */
  hasName: boolean;
  isBanned: boolean;
};

type QueueItem = {
  id: string;
  trackId: string;
  guestId: string | null;
  addedByName: string;
  addedByOwner: boolean;
  status: string;
  createdAt: string;
  trackName: string;
  albumName: string | null;
  albumArt: string | null;
  artistName: string | null;
};

type Track = {
  id: string;
  name: string;
  albumName?: string | null;
  albumArt?: string | null;
  artistName?: string | null;
  year?: string | null;
  explicit?: boolean;
  durationMs?: number | null;
};

type Artist = { id: string; name: string; slug: string; color: string | null };
type Album = { id: string; name: string; art: string | null; year: string | null; tracks: Track[] };

type Toast = { key: string; title: string; by: string; art: string | null; error?: boolean };

// Four seconds. The stage extrapolates the host's position locally between
// polls, so this is about how fast a guest add appears on everybody else's
// phone, not about how tight the video sync is.
const POLL_MS = 4000;

// A room can be between songs or briefly buffering; wait ten minutes before
// deciding the host has truly gone away.
const STALE_MS = 600_000;

const NO_PLAYBACK: Playback = {
  videoId: null,
  trackId: null,
  itemId: null,
  title: null,
  artistName: null,
  positionMs: 0,
  durationMs: 0,
  isPlaying: false,
  lyricOffsetMs: 0,
  updatedAt: null,
};

export default function GuestApp({ code }: { code: string }) {
  const [phase, setPhase] = useState<"loading" | "needsName" | "ready" | "error">("loading");
  const [fatal, setFatal] = useState<string | null>(null);

  const [room, setRoom] = useState<Room | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [nowPlaying, setNowPlaying] = useState<QueueItem | null>(null);
  const [playback, setPlayback] = useState<Playback>(NO_PLAYBACK);
  // Local clock minus server clock. Everything the stage does with time is
  // measured against the server, because the host and the guest are two
  // different laptops with two different ideas of what time it is.
  const [serverOffsetMs, setServerOffsetMs] = useState(0);

  const [view, setView] = useState<"playlist" | "player">("playlist");
  const [playlistStyle, setPlaylistStyle] = useState<"covers" | "detail">("covers");
  const [coverSize, setCoverSize] = useState(150);
  const [addSongsOpen, setAddSongsOpen] = useState(false);
  const [dockHeight, setDockHeight] = useState(92);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[] | null>(null);
  const [catalog, setCatalog] = useState<Track[] | null>(null);

  const [artists, setArtists] = useState<Artist[] | null>(null);
  const [openArtist, setOpenArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<Album[] | null>(null);

  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingAdd, setPendingAdd] = useState<string | null>(null);

  // `since` drives the toast feed, so it has to survive re-renders without
  // causing one.
  const since = useRef<string>(new Date().toISOString());

  const pushToast = useCallback((t: Omit<Toast, "key">) => {
    const key = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev.slice(-2), { ...t, key }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.key !== key)), 4200);
  }, []);

  const applyState = useCallback((d: any) => {
    if (d.jukebox) {
      setRoom(d.jukebox);
      setPlayback(d.jukebox.playback ?? NO_PLAYBACK);
    }
    if (d.guest) setGuest(d.guest);
    if (Array.isArray(d.queue)) setQueue(d.queue);
    setNowPlaying(d.nowPlaying ?? null);
    if (d.serverTime) {
      const at = Date.parse(d.serverTime);
      // Round-trip latency lands in here as a fraction of a second, which is
      // well inside the drift the stage tolerates before it corrects.
      if (Number.isFinite(at)) setServerOffsetMs(Date.now() - at);
    }
  }, []);

  // ── Join ────────────────────────────────────────────────────────────
  const join = useCallback(
    async (name?: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/jukebox/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, name }),
        });
        const d = await res.json();
        if (d.needsName) {
          setRoom(d.jukebox ?? null);
          setPhase("needsName");
          return;
        }
        if (!d.ok) {
          setFatal(d.error ?? "Could not join this jukebox.");
          setPhase("error");
          return;
        }
        applyState(d);
        since.current = new Date().toISOString();
        setPhase("ready");
      } catch {
        setFatal("Could not reach the jukebox. Check your connection.");
        setPhase("error");
      } finally {
        setBusy(false);
      }
    },
    [code, applyState],
  );

  useEffect(() => {
    void join();
  }, [join]);

  // ── Poll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "ready") return;
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/jukebox/state?code=${encodeURIComponent(code)}&since=${encodeURIComponent(since.current)}`,
        );
        const d = await res.json();
        if (!alive || !d.ok) return;
        applyState(d);
        for (const item of d.newAdds ?? []) {
          pushToast({
            title: `${item.artistName ?? ""} — ${item.trackName}`,
            by: item.addedByName,
            art: item.albumArt,
          });
        }
        since.current = d.serverTime ?? new Date().toISOString();
      } catch {
        // A dropped poll is not worth telling the guest about; the next one
        // is five seconds away.
      }
    };

    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [phase, code, applyState, pushToast]);

  // ── Search ──────────────────────────────────────────────────────────
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/jukebox/catalog?code=${encodeURIComponent(code)}&q=${encodeURIComponent(q)}`,
        );
        const d = await res.json();
        if (d.ok) setResults(d.results ?? []);
      } catch {
        /* leave the previous results on screen */
      }
    }, 300);
    return () => clearTimeout(id);
  }, [query, code]);

  // ── Browse ──────────────────────────────────────────────────────────
  const loadArtists = useCallback(async () => {
    if (artists) return;
    try {
      const res = await fetch(`/api/jukebox/catalog?code=${encodeURIComponent(code)}`);
      const d = await res.json();
      if (d.ok) setArtists(d.artists ?? []);
    } catch {
      /* the retry is tapping the tab again */
    }
  }, [artists, code]);

  const loadCatalog = useCallback(async () => {
    try {
      // This is the host's synced Now Playing list, not the room's whole
      // catalogue. It is the same running order the host sees in their player.
      const res = await fetch(`/api/jukebox/offline?code=${encodeURIComponent(code)}`);
      const d = await res.json();
      if (d.ok) {
        setCatalog((d.tracks ?? []).map((track: any) => ({
          id: track.trackId,
          name: track.trackName,
          artistName: track.artistName,
          albumName: track.albumName,
          albumArt: track.albumArt,
          durationMs: track.durationMs,
        })));
      }
    } catch {
      setCatalog([]);
    }
  }, [code]);

  useEffect(() => {
    if (phase === "ready") void loadCatalog();
  }, [room?.lastPlaylistCount, phase, loadCatalog]);

  const openArtistAlbums = useCallback(
    async (artist: Artist) => {
      setOpenArtist(artist);
      setAlbums(null);
      try {
        const res = await fetch(
          `/api/jukebox/catalog?code=${encodeURIComponent(code)}&artist=${artist.id}`,
        );
        const d = await res.json();
        if (d.ok) setAlbums(d.albums ?? []);
      } catch {
        setAlbums([]);
      }
    },
    [code],
  );

  // ── Actions ─────────────────────────────────────────────────────────
  const addTrack = useCallback(
    async (track: Track) => {
      setPendingAdd(track.id);
      try {
        const res = await fetch("/api/jukebox/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, trackId: track.id }),
        });
        const d = await res.json();
        if (!d.ok) {
          pushToast({ title: d.error ?? "Could not add that song.", by: "", art: null, error: true });
          return;
        }
        setQueue((prev) => [...prev, d.item]);
        pushToast({
          title: `${d.item.artistName ?? ""} — ${d.item.trackName}`,
          by: "you added this",
          art: d.item.albumArt,
        });
      } catch {
        pushToast({ title: "Could not reach the jukebox.", by: "", art: null, error: true });
      } finally {
        setPendingAdd(null);
      }
    },
    [code, pushToast],
  );

  const removeItem = useCallback(
    async (item: QueueItem) => {
      setQueue((prev) => prev.filter((q) => q.id !== item.id));
      try {
        const res = await fetch("/api/jukebox/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, itemId: item.id }),
        });
        const d = await res.json();
        if (!d.ok) {
          pushToast({ title: d.error ?? "Could not remove that.", by: "", art: null, error: true });
          setQueue((prev) => [...prev, item].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        }
      } catch {
        pushToast({ title: "Could not reach the jukebox.", by: "", art: null, error: true });
      }
    },
    [code, pushToast],
  );

  const rename = useCallback(async () => {
    // Their own name if they have one; an empty box if the room is still just
    // numbering them, because "Listener 4" is not a suggestion to edit.
    const next = window.prompt(
      "What should the room call you?",
      guest?.hasName ? guest.displayName : "",
    );
    if (next == null) return;
    const res = await fetch("/api/jukebox/name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: next }),
    });
    const d = await res.json();
    if (d.ok) {
      setGuest(d.guest);
      setQueue((prev) =>
        prev.map((q) => (q.guestId === d.guest.id ? { ...q, addedByName: d.guest.displayName } : q)),
      );
    } else {
      pushToast({ title: d.error ?? "Could not change your name.", by: "", art: null, error: true });
    }
  }, [code, guest, pushToast]);

  // ── Render ──────────────────────────────────────────────────────────

  if (phase === "loading") {
    return (
      <div className={css.app}>
        <div className={css.empty}>Finding the jukebox...</div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className={css.app}>
        <div className={css.joinWrap}>
          <div className={css.joinCard}>
            <div className={css.joinTitle}>No jukebox here</div>
            <p className={css.joinSub}>{fatal}</p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "needsName") {
    return (
      <div className={css.app}>
        <div className={css.joinWrap}>
          <div className={css.joinCard}>
            <div className={css.joinTitle}>{room?.name ?? "Jukebox"}</div>
            <p className={css.joinSub}>
              Pick the name the room will see next to your songs. No account, no password.
            </p>
            <input
              className={css.nameInput}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Your name"
              maxLength={40}
            />
            <button
              className={css.primaryBtn}
              disabled={busy || !nameDraft.trim()}
              onClick={() => void join(nameDraft.trim())}
            >
              {busy ? "Joining..." : "Join the jukebox"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const mine = queue.filter((q) => guest && q.guestId === guest.id);
  const cap = room?.settings.maxPendingPerGuest ?? 0;
  const atCap = cap > 0 && mine.length >= cap;
  const banned = !!guest?.isBanned;

  const renderTrackRow = (t: Track) => (
    <div className={css.row} key={t.id}>
      <div className={css.rowBody}>
        <div className={css.rowTitle}>{t.name}</div>
        <div className={css.rowSub}>
          {[t.artistName, t.albumName, t.year].filter(Boolean).join(" · ")}
        </div>
      </div>
      <button
        className={`${css.iconBtn} ${css.addBtn}`}
        disabled={banned || atCap || pendingAdd === t.id}
        onClick={() => void addTrack(t)}
        aria-label={`Add ${t.name} to the jukebox`}
        title={atCap ? "You have reached your limit of waiting songs" : "Add to the jukebox"}
      >
        +
      </button>
    </div>
  );

  // A live video is only trusted while the host is actively playing it and
  // has reported a recent position. Once it goes quiet, nothing in the old
  // queue is shown as if it were still current.
  const stampedAt = playback.updatedAt ? Date.parse(playback.updatedAt) : NaN;
  const fresh =
    Number.isFinite(stampedAt) && Date.now() - serverOffsetMs - stampedAt < STALE_MS;
  const isPlaying = !!playback.videoId && playback.isPlaying && fresh;
  const currentTrack: Track | null = nowPlaying
    ? {
        id: nowPlaying.trackId,
        name: nowPlaying.trackName,
        artistName: nowPlaying.artistName,
        albumName: nowPlaying.albumName,
        albumArt: nowPlaying.albumArt,
      }
    : null;
  const playlistDurationMs = (catalog ?? []).reduce((total, track) => total + (track.durationMs ?? 0), 0);
  const playlistDuration = playlistDurationMs
    ? `${Math.floor(playlistDurationMs / 3_600_000)}:${String(Math.floor((playlistDurationMs / 60_000) % 60)).padStart(2, "0")}:${String(Math.floor((playlistDurationMs / 1000) % 60)).padStart(2, "0")}`
    : null;

  const renderAdd = (track: Track, compact = false) => (
    <button
      className={compact ? css.coverAdd : `${css.iconBtn} ${css.addBtn}`}
      disabled={banned || atCap || pendingAdd === track.id}
      onClick={() => void addTrack(track)}
      aria-label={`Add ${track.name} to the queue`}
      title={atCap ? "You have reached your limit of waiting songs" : "Add to queue"}
    >
      {pendingAdd === track.id ? "Adding…" : compact ? "Add to Queue" : "+"}
    </button>
  );

  return (
    <div className={css.app}>
      <header className={css.header}>
        <div className={css.headRow}>
          <div className={css.roomName}>{room?.name}</div>
          <div className={css.headerIdentity}>
            <span>{guest?.displayName ?? "Guest"}</span>
            {cap > 0 && <span className={css.headerCap}>{mine.length}/{cap}</span>}
            <button className={css.headerRename} onClick={() => void rename()}>{guest?.hasName ? "Rename" : "Name"}</button>
          </div>
          <span className={isPlaying ? css.live : css.dark}>
            {isPlaying ? "Live" : "Idle"}
          </span>
        </div>
      </header>

      {!isPlaying ? (
        <main className={css.idleOverlay} role="status" aria-live="polite">
          <div className={css.idleCard}>
            <div className={css.idleEyebrow}>Jukebox idle</div>
            <h1>Nothing is playing right now</h1>
            <p>The host may have stepped away. Explore Suffering Jukebox on your own while you wait.</p>
            <a className={css.idleLink} href="/">Explore Suffering Jukebox</a>
          </div>
        </main>
      ) : view === "player" ? (
        <main className={css.playerView}>
          <button className={css.playerClose} onClick={() => setView("playlist")}>← Now Playing</button>
          <Stage code={code} playback={playback} serverOffsetMs={serverOffsetMs} />
          {currentTrack && <div className={css.playerAdd}>{renderAdd(currentTrack, true)}</div>}
        </main>
      ) : (
        <main className={css.playlistView}>
          <div className={css.nowPlayingHead}>
            <div>
              <h1>Now Playing</h1>
              <p>{catalog?.length ?? 0} songs{playlistDuration ? `, ${playlistDuration} total play time` : ""}</p>
            </div>
            <div className={css.viewControls}>
              <button className={css.smallBtn} onClick={() => { setQuery(""); setResults(null); setAddSongsOpen(true); }}>Add Songs</button>
              <button className={`${css.smallBtn} ${playlistStyle === "covers" ? css.controlOn : ""}`} onClick={() => setPlaylistStyle("covers")}>Covers</button>
              <button className={`${css.smallBtn} ${playlistStyle === "detail" ? css.controlOn : ""}`} onClick={() => setPlaylistStyle("detail")}>Detail</button>
              {playlistStyle === "covers" && <label className={css.sizeControl}>Size <input type="range" min="110" max="230" value={coverSize} onChange={(e) => setCoverSize(Number(e.target.value))} aria-label="Cover size" /></label>}
            </div>
          </div>
          {banned && <div className={css.notice}>The owner has stopped you adding songs to this jukebox.</div>}
          <section className={css.section}>
            {results !== null ? (
              results.length ? (playlistStyle === "covers" ? <div className={css.coverGrid} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))` }}>{results.map((track) => <article key={track.id} className={css.coverCard}>{track.albumArt ? <img src={track.albumArt} alt="" loading="lazy" /> : <div className={css.coverFallback} />}<div className={css.coverTitle}>{track.name}</div><div className={css.coverSub}>{track.artistName}</div>{renderAdd(track, true)}</article>)}</div> : <div>{results.map(renderTrackRow)}</div>) : <div className={css.empty}>No songs found.</div>
            ) : catalog === null ? <div className={css.empty}>Loading the playlist...</div> : playlistStyle === "covers" ? (
              <div className={css.coverGrid} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))` }}>
                {catalog.map((track) => <article key={track.id} className={css.coverCard}>{track.albumArt ? <img src={track.albumArt} alt="" loading="lazy" /> : <div className={css.coverFallback} />}<div className={css.coverTitle}>{track.name}</div><div className={css.coverSub}>{track.artistName}</div></article>)}
              </div>
            ) : <div>{catalog.map(renderTrackRow)}</div>}
          </section>
          {currentTrack && (
            <div className={css.playerDock} style={{ height: dockHeight }}>
              <label className={css.dockResize} aria-label="Resize docked player"><input type="range" min="76" max="260" value={dockHeight} onChange={(e) => setDockHeight(Number(e.target.value))} /></label>
              <button className={css.dockMain} onClick={() => setView("player")} aria-label="Open the full screen player">
                {currentTrack.albumArt && <img src={currentTrack.albumArt} alt="" />}
                <span className={css.dockMeta}><strong>{currentTrack.name}</strong><span>{currentTrack.artistName}</span></span>
                <span className={css.dockPlay}>Open Player</span>
              </button>
            </div>
          )}
        </main>
      )}

      {addSongsOpen && (
        <div className={css.addSongsModal} role="dialog" aria-modal="true" aria-label="Add songs">
          <div className={css.addSongsPanel}>
            <div className={css.addSongsHead}><strong>Add Songs</strong><button className={css.smallBtn} onClick={() => { setQuery(""); setResults(null); setAddSongsOpen(false); }}>Close</button></div>
            <input className={css.search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the Suffering Jukebox" autoFocus />
            <div className={css.addSongsResults}>{results === null ? "Start typing a song name." : results.length ? results.map(renderTrackRow) : "No songs found."}</div>
          </div>
        </div>
      )}

      <div className={css.toasts}>
        {toasts.map((t) => (
          <div key={t.key} className={`${css.toast} ${t.error ? css.toastErr : ""}`}>
            {t.art && <img className={css.toastArt} src={t.art} alt="" />}
            <div className={css.rowBody}>
              <div className={css.toastTitle}>{t.title}</div>
              {t.by && <div className={css.toastBy}>{t.by}</div>}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
