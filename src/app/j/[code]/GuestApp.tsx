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
  allowDuplicates: boolean;
  allowOfflineAdds: boolean;
  fairness: string;
  requireName: boolean;
  allowExplicit: boolean;
};

type Room = {
  code: string;
  slug: string | null;
  name: string;
  isLive: boolean;
  settings: Settings;
  playback: Playback;
};
type Guest = { id: string; displayName: string; isBanned: boolean };

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
};

type Artist = { id: string; name: string; slug: string; color: string | null };
type Album = { id: string; name: string; art: string | null; year: string | null; tracks: Track[] };

type Toast = { key: string; title: string; by: string; art: string | null; error?: boolean };

// Four seconds. The stage extrapolates the host's position locally between
// polls, so this is about how fast a guest add appears on everybody else's
// phone, not about how tight the video sync is.
const POLL_MS = 4000;

// How long a host may go quiet before the guests stop mirroring it.
const STALE_MS = 120_000;

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

  const [tab, setTab] = useState<"queue" | "browse">("queue");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[] | null>(null);

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
          setNameDraft(d.suggestion ?? "");
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
    const next = window.prompt("What should the room call you?", guest?.displayName ?? "");
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

  const shuffleName = useCallback(async () => {
    const res = await fetch("/api/jukebox/name");
    const d = await res.json();
    if (d.ok) setNameDraft(d.suggestion);
  }, []);

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
            <button className={css.linkBtn} onClick={() => void shuffleName()}>
              Suggest another name
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

  // The mirror only makes sense while the host is actually driving something,
  // and only while it is still saying so. A host that closed its laptop stops
  // writing, and a stale position would have the phone playing a song the room
  // finished ten minutes ago. Past STALE_MS the stage comes down and the plain
  // Now playing card takes over.
  const stampedAt = playback.updatedAt ? Date.parse(playback.updatedAt) : NaN;
  const fresh =
    Number.isFinite(stampedAt) && Date.now() - serverOffsetMs - stampedAt < STALE_MS;
  const showStage = !!playback.videoId && fresh;

  return (
    <div className={css.app}>
      {showStage && <Stage code={code} playback={playback} serverOffsetMs={serverOffsetMs} />}

      <header className={css.header}>
        <div className={css.headRow}>
          <div className={css.roomName}>{room?.name}</div>
          <span className={room?.isLive ? css.live : css.dark}>
            {room?.isLive ? "Live" : "Off air"}
          </span>
        </div>
        <input
          className={css.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a song"
          inputMode="search"
        />
        <div className={css.tabs}>
          <button
            className={`${css.tab} ${tab === "queue" ? css.tabOn : ""}`}
            onClick={() => setTab("queue")}
          >
            Up Next ({queue.length})
          </button>
          <button
            className={`${css.tab} ${tab === "browse" ? css.tabOn : ""}`}
            onClick={() => {
              setTab("browse");
              void loadArtists();
            }}
          >
            Browse
          </button>
        </div>
      </header>

      {banned && (
        <div className={css.notice}>
          The owner has stopped you adding songs to this jukebox. You can still see what is playing.
        </div>
      )}

      {!room?.isLive && !banned && (
        <div className={css.notice}>
          {room?.settings.allowOfflineAdds
            ? "Nobody is playing this jukebox right now. Songs you add will be waiting when it starts up again."
            : "This jukebox is not playing right now, so it is not taking requests."}
        </div>
      )}

      {nowPlaying && !showStage && (
        <div className={css.nowPlaying}>
          {nowPlaying.albumArt && (
            <img className={css.npArt} src={nowPlaying.albumArt} alt="" loading="lazy" />
          )}
          <div className={css.rowBody}>
            <div className={css.npLabel}>Now playing</div>
            <div className={css.npTitle}>{nowPlaying.trackName}</div>
            <div className={css.npSub}>
              {nowPlaying.artistName}
              {nowPlaying.addedByOwner ? "" : ` · added by ${nowPlaying.addedByName}`}
            </div>
          </div>
        </div>
      )}

      {/* Search results take over the body whenever there is a query. */}
      {results !== null ? (
        <section className={css.section}>
          <h2 className={css.sectionTitle}>
            {results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No songs found"}
          </h2>
          {results.map(renderTrackRow)}
        </section>
      ) : tab === "queue" ? (
        <section className={css.section}>
          <h2 className={css.sectionTitle}>Up next</h2>
          {queue.length === 0 ? (
            <div className={css.empty}>
              Nothing queued yet.
              <br />
              Search for a song, or browse the collection.
            </div>
          ) : (
            queue.map((item, i) => {
              const isMine = !!guest && item.guestId === guest.id;
              return (
                <div className={`${css.row} ${isMine ? css.rowMine : ""}`} key={item.id}>
                  <div className={css.pos}>{i + 1}</div>
                  <div className={css.rowBody}>
                    <div className={css.rowTitle}>{item.trackName}</div>
                    <div className={css.rowSub}>
                      {item.artistName}
                      {" · "}
                      <span className={isMine ? css.by : undefined}>
                        {isMine ? "you added this" : item.addedByName}
                      </span>
                    </div>
                  </div>
                  {isMine && (
                    <button
                      className={css.iconBtn}
                      onClick={() => void removeItem(item)}
                      aria-label={`Remove ${item.trackName}`}
                      title="Remove your song"
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })
          )}
        </section>
      ) : (
        <section className={css.section}>
          {openArtist ? (
            <>
              <button
                className={css.backBtn}
                onClick={() => {
                  setOpenArtist(null);
                  setAlbums(null);
                }}
              >
                ← All artists
              </button>
              <h2 className={css.sectionTitle}>{openArtist.name}</h2>
              {albums === null ? (
                <div className={css.empty}>Loading...</div>
              ) : (
                albums.map((album) => (
                  <div key={album.id}>
                    <div className={css.albumHead}>
                      {album.art && <img className={css.albumArt} src={album.art} alt="" loading="lazy" />}
                      <div>
                        <div className={css.albumName}>{album.name}</div>
                        <div className={css.albumYear}>{album.year}</div>
                      </div>
                    </div>
                    {album.tracks.map((t) =>
                      renderTrackRow({ ...t, artistName: openArtist.name, albumName: album.name }),
                    )}
                  </div>
                ))
              )}
            </>
          ) : artists === null ? (
            <div className={css.empty}>Loading the collection...</div>
          ) : (
            <div className={css.artistGrid}>
              {artists.map((a) => (
                <button
                  key={a.id}
                  className={css.artistCard}
                  style={{ ["--card-accent" as string]: a.color ?? "#ff6b35" }}
                  onClick={() => void openArtistAlbums(a)}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </section>
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

      <div className={css.identity}>
        <div className={css.identityText}>
          Adding as
          <span className={css.identityName}>{guest?.displayName ?? "Guest"}</span>
        </div>
        {cap > 0 && (
          <div className={css.identityText} style={{ flex: "0 0 auto", textAlign: "right" }}>
            {mine.length}/{cap}
            <span className={css.identityName} style={{ fontSize: "0.62rem", fontWeight: 500 }}>
              waiting
            </span>
          </div>
        )}
        <button className={css.smallBtn} onClick={() => void rename()}>
          Rename
        </button>
      </div>
    </div>
  );
}
