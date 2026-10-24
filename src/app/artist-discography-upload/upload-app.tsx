"use client";

/**
 * Artist upload, as one page in three steps: drop the music, check it, go
 * public. Modelled on Bandcamp and SoundCloud, where files start uploading the
 * moment they land and the details are filled in from the files' own tags
 * while that happens.
 *
 * It replaced two pages (a one-release-at-a-time form here, and the separate
 * rights form at /artist-upload) that asked the same artist for the same
 * things twice. /artist-upload now renders this page too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";
import { consumeNativeSessionHandoff } from "@/lib/native-session-handoff";
import {
  isAudioFileName, isCoverFileName, planReleases, readAudioTags, extensionOf,
  UNPLAYABLE_AUDIO_EXTENSIONS, type AudioTags, type PlannedRelease,
} from "@/lib/audio-tags";
import {
  ACCOUNT_LIMIT, FILE_LIMIT, MB, VERIFIED_FILE_LIMIT, authHeaders, durationOf, megabytes, post,
  uploadAudio, uploadCover, type Artist, type DraftRelease, type Grant,
} from "./client";
import GoPublic, { type RightsData } from "./go-public";
import styles from "./upload.module.css";

type Picked = { file: File; path: string };
type Plan = {
  files: File[];
  paths: string[];
  tags: Array<AudioTags | null>;
  releases: PlannedRelease[];
  /** One per release, worked out once so previews don't rebuild each render. */
  releaseCovers: Array<File | null>;
  covers: Map<string, File>;
  skipped: Array<{ name: string; reason: string }>;
  artistName: string;
};
type Job = { state: "queued" | "uploading" | "done" | "failed"; pct: number; error?: string; file: File };
type QueueItem = { trackId: string; file: File; fileLimit: number };

const UPLOAD_CONCURRENCY = 3;
const TAG_CONCURRENCY = 6;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * A dropped folder arrives as directory entries, not files, and the paths
 * inside it are what tell one album from the next.
 */
async function filesFromDrop(dt: DataTransfer): Promise<Picked[]> {
  const entries = Array.from(dt.items ?? []).map((item) => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(dt.files).map((file) => ({ file, path: file.name }));
  const out: Picked[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: entry.fullPath.replace(/^\//, "") });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        // readEntries hands back a page at a time and an empty page at the end.
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

function pictureFile(tags: AudioTags | null): File | null {
  const pic = tags?.picture;
  if (!pic || !["image/jpeg", "image/png", "image/webp"].includes(pic.mime) || pic.bytes.length > 5 * MB) return null;
  return new File([pic.bytes as BlobPart], `cover.${pic.mime.split("/")[1]}`, { type: pic.mime });
}

/** Titles save on blur, so Enter is the "done" key. */
function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") e.currentTarget.blur();
}

function releaseStatus(release: DraftRelease, jobs: Record<string, Job>) {
  if (release.published_album_id) return { label: "Live", tone: "live" };
  if (release.submitted_at) return { label: "In review", tone: "review" };
  const active = release.tracks.filter((t) => ["queued", "uploading"].includes(jobs[t.id]?.state ?? "")).length;
  if (active) return { label: `Uploading ${release.tracks.length - active} of ${release.tracks.length}`, tone: "busy" };
  const missing = release.tracks.filter((t) => !t.audio).length;
  if (!release.tracks.length) return { label: "No songs yet", tone: "warn" };
  if (missing) return { label: `${missing} song${missing === 1 ? "" : "s"} need audio`, tone: "warn" };
  return { label: "Ready to go public", tone: "ready" };
}

export default function UploadApp({ brand }: { brand: { name: string } }) {
  const [auth, setAuth] = useState<"loading" | "out" | "in">("loading");
  const [userName, setUserName] = useState("");
  const [artists, setArtists] = useState<Artist[]>([]);
  const [releases, setReleases] = useState<DraftRelease[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [rights, setRights] = useState<RightsData | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reading, setReading] = useState("");
  const [starting, setStarting] = useState("");
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [localCovers, setLocalCovers] = useState<Record<string, string>>({});
  const [fromNativeApp, setFromNativeApp] = useState(false);
  const queue = useRef<QueueItem[]>([]);
  const active = useRef(0);

  const refresh = useCallback(async () => {
    const headers = await authHeaders();
    const [artistResult, draftResponse, rightsResponse] = await Promise.all([
      sjBrowserAuth.schema("jukebox").from("artists")
        .select("id,name,slug").eq("visibility", "public").order("name").limit(2000),
      fetch("/api/artist-discography", { headers, cache: "no-store" }),
      fetch("/api/sj-artist-rights", { headers, cache: "no-store" }),
    ]);
    if (artistResult.error) throw artistResult.error;
    const drafts = await draftResponse.json();
    if (!draftResponse.ok || !drafts.ok) throw new Error(drafts.error || "Could not load your music.");
    const combined = new Map<string, Artist>();
    for (const artist of [...(artistResult.data ?? []), ...(drafts.ownedArtists ?? [])]) combined.set(artist.id, artist);
    setArtists([...combined.values()].sort((a, b) => a.name.localeCompare(b.name)));
    setReleases(drafts.releases ?? []);
    setGrants(drafts.grants ?? []);
    const r = await rightsResponse.json().catch(() => ({}));
    if (rightsResponse.ok && r.ok) setRights(r);
  }, []);

  useEffect(() => {
    let alive = true;
    consumeNativeSessionHandoff().then(async (handoff) => {
      const data = handoff ? { session: handoff.session } : (await sjBrowserAuth.auth.getSession()).data;
      if (!alive) return;
      setFromNativeApp(!!handoff?.fromNativeApp);
      setAuth(data.session ? "in" : "out");
      const meta = data.session?.user.user_metadata ?? {};
      setUserName(String(meta.full_name || meta.name || ""));
      if (data.session) await refresh();
      if (new URLSearchParams(location.search).get("step") === "publish") {
        setTimeout(() => document.getElementById("go-public")?.scrollIntoView({ behavior: "smooth" }), 300);
      }
    }).catch((error) => { if (alive) setNotice(error.message); });
    return () => { alive = false; };
  }, [refresh]);

  // Dropping a file anywhere else on the page would navigate away from it.
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);

  // Closing the tab mid-upload loses the files still waiting.
  const uploading = Object.values(jobs).some((j) => j.state === "queued" || j.state === "uploading");
  useEffect(() => {
    if (!uploading && !starting) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading, starting]);

  const setJob = (trackId: string, patch: Partial<Job> & { file?: File }) =>
    setJobs((cur) => ({ ...cur, [trackId]: { ...(cur[trackId] ?? { state: "queued", pct: 0, file: patch.file! }), ...patch } }));

  const pump = useCallback(() => {
    while (active.current < UPLOAD_CONCURRENCY && queue.current.length) {
      const item = queue.current.shift()!;
      active.current++;
      setJob(item.trackId, { state: "uploading", pct: 0 });
      uploadAudio(item.trackId, item.file, item.fileLimit, (pct) => setJob(item.trackId, { pct }))
        .then(() => {
          setJob(item.trackId, { state: "done", pct: 100 });
          setReleases((cur) => cur.map((r) => ({ ...r, tracks: r.tracks.map((t) =>
            t.id === item.trackId ? { ...t, audio: { file_bytes: item.file.size } } : t) })));
        })
        .catch((error) => setJob(item.trackId, { state: "failed", error: (error as Error).message }))
        .finally(() => {
          active.current--;
          if (!queue.current.length && active.current === 0) void refresh().catch(() => undefined);
          pump();
        });
    }
  }, [refresh]);

  const enqueue = useCallback((trackId: string, file: File, fileLimit: number) => {
    setJob(trackId, { state: "queued", pct: 0, file, error: undefined });
    queue.current.push({ trackId, file, fileLimit });
    pump();
  }, [pump]);

  const fileLimitFor = (artistId: string) => grants.some((g) => g.artist_id === artistId) ? VERIFIED_FILE_LIMIT : FILE_LIMIT;

  async function intake(picked: Picked[]) {
    if (!picked.length) return;
    setNotice("");
    const audio: Picked[] = [];
    const covers = new Map(plan?.covers ?? []);
    const skipped = [...(plan?.skipped ?? [])];
    for (const p of picked) {
      const ext = extensionOf(p.file.name);
      if (isAudioFileName(p.file.name)) audio.push(p);
      else if (isCoverFileName(p.path) && /^image\/(jpeg|png|webp)$/.test(p.file.type)) {
        covers.set(p.path.split(/[\\/]/).slice(0, -1).join("/"), p.file);
      } else if (UNPLAYABLE_AUDIO_EXTENSIONS.includes(ext)) {
        skipped.push({ name: p.path, reason: `.${ext} files don't play in web browsers. Export it as WAV, FLAC or MP3.` });
      }
    }
    if (!audio.length) {
      setNotice(skipped.length ? "None of those files can be played here yet. See the list below." : "No audio files in that drop. MP3, WAV, FLAC, M4A, OGG and Opus all work.");
      if (skipped.length) setPlan((p) => p ? { ...p, skipped } : { files: [], paths: [], tags: [], releases: [], releaseCovers: [], covers, skipped, artistName: "" });
      return;
    }
    const files = [...(plan?.files ?? []), ...audio.map((p) => p.file)];
    const paths = [...(plan?.paths ?? []), ...audio.map((p) => p.path)];
    let read = 0;
    setReading(`Reading your files… 0 of ${audio.length}`);
    const fresh = await mapLimit(audio, TAG_CONCURRENCY, async (p) => {
      const tags = await readAudioTags(p.file);
      read++;
      if (read % 4 === 0 || read === audio.length) setReading(`Reading your files… ${read} of ${audio.length}`);
      return tags;
    });
    setReading("");
    const tags = [...(plan?.tags ?? []), ...fresh];
    const planned = planReleases(files.map((f, i) => ({ path: paths[i], size: f.size, tags: tags[i] })));
    const tagged = planned.map((r) => r.artist).find(Boolean) ?? "";
    // A cover.jpg beside the songs beats the picture inside them: it is the
    // one the artist chose to keep next to the record.
    const releaseCovers = planned.map((r) => covers.get(r.folder) ?? pictureFile(r.pictureFrom != null ? tags[r.pictureFrom] : null));
    setPlan({ files, paths, tags, releases: planned, releaseCovers, covers, skipped, artistName: plan?.artistName || tagged });
    setTimeout(() => document.getElementById("plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  async function resolveArtist(name: string): Promise<string> {
    const match = artists.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
    if (match) return match.id;
    const created = await post("create-artist", { name: name.trim() });
    return created.artistId;
  }

  async function start() {
    if (!plan || !plan.artistName.trim()) { setNotice("Tell us whose music this is first."); return; }
    const current = plan;
    setStarting("Setting up your releases…");
    setNotice("");
    try {
      const artistId = await resolveArtist(current.artistName);
      const fileLimit = fileLimitFor(artistId);
      const tooBig: string[] = [];
      for (const [n, planned] of current.releases.entries()) {
        setStarting(`Setting up ${planned.title} (${n + 1} of ${current.releases.length})…`);
        const songs = planned.tracks.filter((t) => {
          if (current.files[t.file].size <= fileLimit) return true;
          tooBig.push(current.files[t.file].name);
          return false;
        });
        if (!songs.length) continue;
        const created = await post("create-release", { artistId, name: planned.title.slice(0, 200),
          releaseDate: planned.year ? `${planned.year}-01-01` : null, isUnreleased: false });
        const cover = current.releaseCovers[n];
        if (cover) {
          setLocalCovers((c) => ({ ...c, [created.releaseId]: URL.createObjectURL(cover) }));
          uploadCover(created.releaseId, cover).catch((error) => setNotice(`Cover for ${planned.title}: ${(error as Error).message}`));
        }
        const durations = await mapLimit(songs, 4, (t) => durationOf(current.files[t.file]));
        for (const [i, t] of songs.entries()) {
          const track = await post("create-track", { releaseId: created.releaseId, name: t.title.slice(0, 200) || "Untitled",
            trackNumber: i + 1, discNumber: 1, durationMs: durations[i] ? Math.round(durations[i]! * 1000) : null });
          enqueue(track.trackId, current.files[t.file], fileLimit);
        }
        await refresh();
      }
      setPlan(null);
      if (tooBig.length) {
        setNotice(`${tooBig.length} file${tooBig.length === 1 ? " was" : "s were"} over ${fileLimit / MB} MB and left out: ${tooBig.join(", ")}. Export ${tooBig.length === 1 ? "it" : "them"} as FLAC (about half the size of WAV) or MP3, then drop ${tooBig.length === 1 ? "it" : "them"} on the release.`);
      }
      setTimeout(() => document.getElementById("check")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (error) {
      setNotice((error as Error).message);
      await refresh().catch(() => undefined);
    } finally { setStarting(""); }
  }

  async function save(action: string, body: Record<string, unknown>, okText?: string) {
    try { await post(action, body); if (okText) setNotice(okText); }
    catch (error) { setNotice((error as Error).message); await refresh().catch(() => undefined); }
  }

  function patchRelease(id: string, patch: Partial<DraftRelease>) {
    setReleases((cur) => cur.map((r) => r.id === id ? { ...r, ...patch } : r));
  }

  async function move(release: DraftRelease, index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= release.tracks.length) return;
    const tracks = [...release.tracks];
    [tracks[index], tracks[to]] = [tracks[to], tracks[index]];
    patchRelease(release.id, { tracks: tracks.map((t, i) => ({ ...t, track_number: i + 1 })) });
    await save("reorder-tracks", { releaseId: release.id, trackIds: tracks.map((t) => t.id) });
  }

  async function removeTrack(release: DraftRelease, trackId: string, name: string) {
    if (!confirm(`Remove "${name}" from ${release.name}? Its audio is deleted too.`)) return;
    queue.current = queue.current.filter((q) => q.trackId !== trackId);
    patchRelease(release.id, { tracks: release.tracks.filter((t) => t.id !== trackId) });
    await save("delete-track", { trackId });
    const rest = release.tracks.filter((t) => t.id !== trackId);
    if (rest.some((t, i) => t.track_number !== i + 1)) await save("reorder-tracks", { releaseId: release.id, trackIds: rest.map((t) => t.id) });
    await refresh().catch(() => undefined);
  }

  async function removeRelease(release: DraftRelease) {
    if (!confirm(`Delete ${release.name} and all ${release.tracks.length} songs on it? This can't be undone.`)) return;
    const ids = new Set(release.tracks.map((t) => t.id));
    queue.current = queue.current.filter((q) => !ids.has(q.trackId));
    setReleases((cur) => cur.filter((r) => r.id !== release.id));
    await save("delete-release", { releaseId: release.id }, `${release.name} was deleted.`);
    await refresh().catch(() => undefined);
  }

  async function addSongs(release: DraftRelease, list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => isAudioFileName(f.name));
    if (!files.length) return;
    const fileLimit = fileLimitFor(release.artist_id);
    try {
      let number = Math.max(0, ...release.tracks.map((t) => t.track_number));
      for (const file of files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        const tags = await readAudioTags(file);
        const duration = await durationOf(file);
        const title = tags?.title || file.name.replace(/\.[^.]+$/, "").replace(/^\s*\d{1,3}\s*[-.)]+\s*/, "");
        const track = await post("create-track", { releaseId: release.id, name: title.slice(0, 200), trackNumber: ++number,
          discNumber: 1, durationMs: duration ? Math.round(duration * 1000) : null });
        enqueue(track.trackId, file, fileLimit);
      }
      await refresh();
    } catch (error) { setNotice((error as Error).message); }
  }

  async function replaceCover(release: DraftRelease, file: File | undefined) {
    if (!file) return;
    setLocalCovers((c) => ({ ...c, [release.id]: URL.createObjectURL(file) }));
    try { await uploadCover(release.id, file); } catch (error) { setNotice((error as Error).message); }
  }

  async function signIn() {
    await sjBrowserAuth.auth.signInWithOAuth({ provider: "google",
      options: { redirectTo: `${location.origin}${location.pathname}${location.search}` } });
  }

  const drafts = releases.filter((r) => !r.published_album_id && !r.submitted_at);
  const done = releases.filter((r) => r.published_album_id || r.submitted_at);
  const busyArtists = useMemo(() => new Set(releases.filter((r) =>
    r.tracks.some((t) => ["queued", "uploading"].includes(jobs[t.id]?.state ?? ""))).map((r) => r.artist_id)), [releases, jobs]);
  const planBytes = plan?.files.reduce((n, f) => n + f.size, 0) ?? 0;
  const planArtist = plan ? artists.find((a) => a.name.toLowerCase() === plan.artistName.trim().toLowerCase()) : undefined;
  const planLimit = planArtist ? fileLimitFor(planArtist.id) : FILE_LIMIT;
  const planTooBig = plan?.files.filter((f) => f.size > planLimit) ?? [];
  const songCount = releases.reduce((n, r) => n + r.tracks.length, 0);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    void filesFromDrop(e.dataTransfer).then(intake).catch((error) => setNotice((error as Error).message));
  }
  function onPick(list: FileList | null) {
    void intake(Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name })));
  }

  return <main className={styles.page}>
    <nav className={styles.nav}>{fromNativeApp
      ? <button type="button" className={styles.linkButton} onClick={() => window.history.back()}>‹ Back to the app</button>
      : <a href="/">← Back to {brand.name}</a>}<a href="/artist-agreement">Artist agreement</a></nav>

    <header className={styles.hero}>
      <p className={styles.eyebrow}>For artists</p>
      <h1>Put your music on {brand.name}.</h1>
      <p>Drop a folder or a few songs. They start uploading straight away, and the album names, track order and covers are filled in from your files. Nothing is public until you choose to go public and we confirm the music is yours.</p>
      <ol className={styles.steps}>
        <li><a href="#add"><b>1</b> Add music</a></li>
        <li><a href="#check"><b>2</b> Check the details{songCount ? ` · ${songCount} songs` : ""}</a></li>
        <li><a href="#go-public"><b>3</b> Go public</a></li>
      </ol>
    </header>

    {auth === "loading" && <p className={styles.muted}>Loading…</p>}
    {auth === "out" && <section className={styles.card}>
      <h2>Sign in to start</h2>
      <p className={styles.muted}>Your uploads are saved to your account, so you can stop and come back any time.</p>
      <button className={styles.primary} onClick={signIn}>Sign in with Google</button>
    </section>}

    {auth === "in" && <>
      <section id="add" className={styles.section}>
        <h2 className={styles.stepTitle}><b>1</b> Add music</h2>
        <label className={`${styles.drop} ${dragging ? styles.dropActive : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <input type="file" multiple accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.opus" className={styles.hidden}
            onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
          <span className={styles.dropIcon} aria-hidden>♫</span>
          <strong>Drop songs or a whole folder here</strong>
          <span className={styles.muted}>or click to choose files</span>
        </label>
        <div className={styles.dropRow}>
          <label className={styles.secondary}>Choose a folder
            <input type="file" multiple className={styles.hidden}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} /></label>
          <span className={styles.muted}>MP3, WAV, FLAC, M4A, OGG or Opus · up to {FILE_LIMIT / MB} MB a song ({VERIFIED_FILE_LIMIT / MB} MB once you&apos;re verified) · a folder with several albums becomes several releases</span>
        </div>
        {reading && <p className={styles.muted}>{reading}</p>}

        {plan && <div id="plan" className={styles.card}>
          {!!plan.releases.length && <>
            <h3>Found {plan.releases.length} release{plan.releases.length === 1 ? "" : "s"}, {plan.files.length} song{plan.files.length === 1 ? "" : "s"}</h3>
            <label className={styles.field}>Whose music is this?
              <input list="sj-artists" value={plan.artistName} maxLength={160} placeholder="Artist or band name"
                onChange={(e) => setPlan({ ...plan, artistName: e.target.value })} />
              <datalist id="sj-artists">{artists.map((a) => <option key={a.id} value={a.name} />)}</datalist>
              <small className={styles.muted}>{planArtist ? "Already on the site, so these go under that artist." : plan.artistName.trim() ? "New here. We'll set up a private artist page for it." : "Type a name, or pick one already on the site."}</small>
            </label>
            <ul className={styles.planList}>{plan.releases.map((r, n) => {
              const pic = plan.releaseCovers[n];
              return <li key={r.key}>
                <PreviewCover file={pic} />
                <div><strong>{r.title}</strong><small className={styles.muted}>{r.year ? `${r.year} · ` : ""}{r.tracks.length} song{r.tracks.length === 1 ? "" : "s"}{pic ? "" : " · no cover found"}</small>
                  <span className={styles.muted}>{r.tracks.slice(0, 4).map((t) => t.title).join(", ")}{r.tracks.length > 4 ? "…" : ""}</span></div>
              </li>;
            })}</ul>
            {!!planTooBig.length && <p className={styles.warn}>{planTooBig.length} file{planTooBig.length === 1 ? " is" : "s are"} over {planLimit / MB} MB and will be left out: {planTooBig.map((f) => f.name).join(", ")}. A WAV runs about 10 MB a minute; the same song as FLAC is about half that.</p>}
            {!planArtist && planBytes > ACCOUNT_LIMIT && <p className={styles.warn}>This is {megabytes(planBytes)}. New accounts hold {ACCOUNT_LIMIT / MB} MB until we verify you, so the last songs may not fit. Upload what fits, go public, and we&apos;ll raise your space when we approve you.</p>}
            <p className={styles.muted}>You can rename songs, change the order and swap covers in the next step, while the files upload.</p>
            <div className={styles.actions}>
              <button className={styles.primary} disabled={!!starting || !plan.artistName.trim()} onClick={start}>{starting || "Start uploading"}</button>
              <button className={styles.secondary} disabled={!!starting} onClick={() => setPlan(null)}>Cancel</button>
            </div>
          </>}
          {!!plan.skipped.length && <div className={styles.warn}><strong>Not added</strong><ul>{plan.skipped.map((s) => <li key={s.name}>{s.name}: {s.reason}</li>)}</ul></div>}
        </div>}
      </section>

      {notice && <p role="status" className={styles.notice}>{notice}<button className={styles.linkButton} onClick={() => setNotice("")} aria-label="Dismiss">✕</button></p>}

      <section id="check" className={styles.section}>
        <h2 className={styles.stepTitle}><b>2</b> Check the details</h2>
        {!drafts.length && <p className={styles.muted}>Your releases show up here as soon as you add music. Everything saves as you type.</p>}
        {drafts.map((release) => {
          const status = releaseStatus(release, jobs);
          const cover = localCovers[release.id] || release.art_preview_url;
          return <article key={release.id} className={styles.release}>
            <div className={styles.releaseHead}>
              <label className={styles.cover} title="Add or replace the cover">
                {cover ? <img src={cover} alt="" /> : <span>Add cover</span>}
                <input type="file" accept="image/jpeg,image/png,image/webp" className={styles.hidden}
                  onChange={(e) => { void replaceCover(release, e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <div className={styles.releaseFields}>
                <small className={styles.muted}>{release.artist?.name}</small>
                <input className={styles.titleInput} aria-label="Release title" defaultValue={release.name} maxLength={200} onKeyDown={blurOnEnter}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== release.name) { patchRelease(release.id, { name: v }); void save("update-release", { releaseId: release.id, name: v }); } }} />
                <div className={styles.inline}>
                  <label>Released<input type="date" value={release.release_date ?? ""} disabled={release.is_unreleased}
                    onChange={(e) => { patchRelease(release.id, { release_date: e.target.value || null }); void save("update-release", { releaseId: release.id, releaseDate: e.target.value || null }); }} /></label>
                  <label className={styles.check}><input type="checkbox" checked={release.is_unreleased}
                    onChange={(e) => { patchRelease(release.id, { is_unreleased: e.target.checked, release_date: e.target.checked ? null : release.release_date }); void save("update-release", { releaseId: release.id, isUnreleased: e.target.checked }); }} /> Not released anywhere yet</label>
                </div>
                {!cover && <small className={styles.muted}>Tip: a square cover, 1400 × 1400 or bigger, looks best.</small>}
              </div>
              <span className={`${styles.pill} ${styles[status.tone]}`}>{status.label}</span>
            </div>
            <ol className={styles.tracks}>{release.tracks.map((track, i) => {
              const job = jobs[track.id];
              return <li key={track.id}>
                <span className={styles.num}>{i + 1}</span>
                <input aria-label={`Title of song ${i + 1}`} defaultValue={track.name} maxLength={200} onKeyDown={blurOnEnter}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== track.name) void save("update-track", { trackId: track.id, name: v }); }} />
                <span className={styles.trackState}>
                  {job && (job.state === "queued" || job.state === "uploading")
                    ? <span className={styles.progress}><span style={{ width: `${job.state === "queued" ? 0 : job.pct}%` }} /><em>{job.state === "queued" ? "Waiting" : `${job.pct}%`}</em></span>
                    : job?.state === "failed"
                      ? <span className={styles.failed} title={job.error}>{job.error}
                          <button className={styles.linkButton} onClick={() => enqueue(track.id, job.file, fileLimitFor(release.artist_id))}>Retry</button></span>
                      : track.audio
                        ? <span className={styles.ok}>✓ Uploaded</span>
                        : <label className={styles.linkButton}>Add audio<input type="file" accept="audio/*,.flac" className={styles.hidden}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) enqueue(track.id, f, fileLimitFor(release.artist_id)); e.target.value = ""; }} /></label>}
                </span>
                <span className={styles.rowTools}>
                  <button aria-label="Move up" disabled={i === 0} onClick={() => move(release, i, -1)}>↑</button>
                  <button aria-label="Move down" disabled={i === release.tracks.length - 1} onClick={() => move(release, i, 1)}>↓</button>
                  <button aria-label={`Remove ${track.name}`} onClick={() => removeTrack(release, track.id, track.name)}>✕</button>
                </span>
              </li>;
            })}</ol>
            <div className={styles.actions}>
              <label className={styles.secondary}>+ Add songs<input type="file" multiple accept="audio/*,.flac" className={styles.hidden}
                onChange={(e) => { void addSongs(release, e.target.files); e.target.value = ""; }} /></label>
              <button className={styles.danger} onClick={() => removeRelease(release)}>Delete release</button>
            </div>
          </article>;
        })}
        {!!done.length && <details className={styles.doneList}><summary>{done.length} release{done.length === 1 ? "" : "s"} already submitted</summary>
          <ul>{done.map((r) => <li key={r.id}><strong>{r.name}</strong> · {r.artist?.name} · {r.tracks.length} songs <span className={`${styles.pill} ${styles[releaseStatus(r, jobs).tone]}`}>{releaseStatus(r, jobs).label}</span></li>)}</ul>
        </details>}
      </section>

      <GoPublic rights={rights} busyArtists={busyArtists} userName={userName}
        onChanged={() => refresh().catch((error) => setNotice((error as Error).message))} />
    </>}
  </main>;
}

function PreviewCover({ file }: { file: File | null }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) { setUrl(""); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return <span className={styles.thumb}>{url ? <img src={url} alt="" /> : "♫"}</span>;
}
