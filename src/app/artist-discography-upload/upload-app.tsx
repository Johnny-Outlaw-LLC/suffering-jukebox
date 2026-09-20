"use client";

import { useEffect, useState } from "react";
import { sjBrowserAuth } from "@/lib/sj-browser-auth";
import styles from "./upload.module.css";

type Artist = { id: string; name: string; slug: string | null };
type DraftTrack = { id: string; name: string; track_number: number; audio: { file_bytes: number } | null };
type DraftRelease = { id: string; artist_id: string; name: string; release_date: string | null;
  is_unreleased: boolean; art_storage_path: string | null; submitted_at: string | null; published_album_id: string | null; artist: Artist | null; tracks: DraftTrack[] };
type FileRow = { file: File; name: string; number: number };

async function authHeaders() {
  const { data: { session } } = await sjBrowserAuth.auth.getSession();
  if (!session) throw new Error("Sign in to upload music.");
  return { Authorization: `Bearer ${session.access_token}` };
}

async function post(action: string, body: Record<string, unknown>) {
  const response = await fetch("/api/artist-discography", {
    method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders() },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "Could not save the release.");
  return data;
}

async function durationOf(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio();
      const done = (value: number | null) => { audio.src = ""; resolve(value); };
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
      audio.onerror = () => done(null);
      audio.src = url;
      setTimeout(() => done(null), 5000);
    });
  } finally { URL.revokeObjectURL(url); }
}

async function uploadAudio(trackId: string, file: File, verifiedArtist = false) {
  const maxMb = verifiedArtist ? 250 : 50;
  if (file.size <= 0 || file.size > maxMb * 1024 * 1024) throw new Error(`${file.name}: use an audio file under ${maxMb} MB.`);
  const contentType = file.type || "audio/mpeg";
  if (!/^audio\//.test(contentType)) throw new Error(`${file.name}: audio files only.`);
  const headers = await authHeaders();
  const prepared = await fetch("/api/sj-audio", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "upload-url", trackId, fileName: file.name,
      contentType, fileBytes: file.size }),
  });
  const upload = await prepared.json();
  if (!prepared.ok || !upload.ok) throw new Error(upload.error || "Could not prepare audio upload.");
  const put = await fetch(upload.uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": contentType } });
  if (!put.ok) throw new Error(`${file.name}: upload failed.`);
  const duration = await durationOf(file);
  const completed = await fetch("/api/sj-audio", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ action: "complete", trackId, path: upload.path, durationSeconds: duration }),
  });
  const result = await completed.json();
  if (!completed.ok || !result.ok) throw new Error(result.error || `${file.name}: upload could not be saved.`);
}

async function uploadCover(releaseId: string, file: File) {
  const form = new FormData();
  form.set("releaseId", releaseId);
  form.set("art", file);
  const response = await fetch("/api/artist-discography/art", {
    method: "POST", headers: await authHeaders(), body: form,
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || "Cover upload failed.");
}

function titleFromFile(file: File) {
  return file.name.replace(/\.[^.]+$/, "").replace(/^\s*(?:\d+[.\- _]+)+/, "").replace(/[_]+/g, " ").trim();
}

export default function UploadApp() {
  const [signedIn, setSignedIn] = useState(false);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [releases, setReleases] = useState<DraftRelease[]>([]);
  const [grants, setGrants] = useState<Array<{ artist_id: string; limit_bytes: number }>>([]);
  const [artistId, setArtistId] = useState("");
  const [newArtistName, setNewArtistName] = useState("");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [unreleased, setUnreleased] = useState(false);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [cover, setCover] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    const [artistResult, draftResponse] = await Promise.all([
      sjBrowserAuth.schema("jukebox").from("artists")
        .select("id,name,slug").eq("visibility", "public").order("name").limit(1000),
      fetch("/api/artist-discography", { headers: await authHeaders(), cache: "no-store" }),
    ]);
    if (artistResult.error) throw artistResult.error;
    const drafts = await draftResponse.json();
    if (!draftResponse.ok || !drafts.ok) throw new Error(drafts.error || "Could not load drafts.");
    const combined = new Map<string, Artist>();
    for (const artist of [...(artistResult.data ?? []), ...(drafts.ownedArtists ?? [])]) combined.set(artist.id, artist);
    setArtists([...combined.values()].sort((a, b) => a.name.localeCompare(b.name)));
    setReleases(drafts.releases ?? []);
    setGrants(drafts.grants ?? []);
  }

  useEffect(() => {
    let active = true;
    sjBrowserAuth.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSignedIn(!!data.session);
      if (data.session) await refresh();
    }).catch((error) => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);

  async function signIn() {
    await sjBrowserAuth.auth.signInWithOAuth({ provider: "google",
      options: { redirectTo: `${location.origin}/artist-discography-upload` } });
  }

  function pickFiles(list: FileList | null) {
    setFiles(Array.from(list ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((file, i) => ({ file, name: titleFromFile(file), number: i + 1 })));
  }

  async function createArtist() {
    if (!newArtistName.trim()) return;
    setBusy(true);
    try {
      const created = await post("create-artist", { name: newArtistName });
      await refresh();
      setArtistId(created.artistId);
      setNewArtistName("");
      setMessage(created.existing ? "Selected the existing artist. Add a release below." : "Artist draft created. Add a release below; the artist stays private until approval.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!files.length) {
      setMessage("Choose at least one audio file before saving this release.");
      return;
    }
    if (!artistId && !newArtistName.trim()) {
      setMessage("Choose an artist, or enter a new artist name above.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      let releaseArtistId = artistId;
      if (!releaseArtistId) {
        const createdArtist = await post("create-artist", { name: newArtistName });
        releaseArtistId = createdArtist.artistId;
        setArtistId(releaseArtistId);
        setNewArtistName("");
      }
      const created = await post("create-release", { artistId: releaseArtistId, name, releaseDate: unreleased ? null : date || null,
        isUnreleased: unreleased });
      let success = 0;
      const failures: string[] = [];
      if (cover) {
        try {
          await uploadCover(created.releaseId, cover);
        } catch (error) { failures.push(`Cover: ${(error as Error).message}`); }
      }
      for (const row of files) {
        try {
          setMessage(`Uploading ${success + failures.length + 1} of ${files.length}: ${row.name}`);
          const duration = await durationOf(row.file);
          const track = await post("create-track", { releaseId: created.releaseId, name: row.name,
            trackNumber: row.number, discNumber: 1, durationMs: duration ? Math.round(duration * 1000) : null });
          await uploadAudio(track.trackId, row.file, grants.some((grant) => grant.artist_id === releaseArtistId));
          success++;
        } catch (error) { failures.push(`${row.name}: ${(error as Error).message}`); }
      }
      await refresh();
      setFiles([]);
      setCover(null);
      setName("");
      setDate("");
      setMessage(`${success} track${success === 1 ? "" : "s"} uploaded to a private draft.${failures.length ? ` ${failures.length} need attention: ${failures.join("; ")}` : " Review the catalog below, then sign the license."}`);
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function retry(trackId: string, artist: string, file: File) {
    setBusy(true);
    setMessage(`Uploading ${file.name}…`);
    try { await uploadAudio(trackId, file, grants.some((grant) => grant.artist_id === artist)); await refresh(); setMessage(`${file.name} is ready in the private draft.`); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  async function retryCover(releaseId: string, file: File) {
    setBusy(true);
    try { await uploadCover(releaseId, file); await refresh(); setMessage("Cover is ready in the private draft."); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }

  return <main className={styles.page}>
    <nav><a href="/">← Back to the jukebox</a><a href="/artist-upload">Rights submission</a></nav>
    <header><p>ARTIST STUDIO</p><h1>Upload a complete discography.</h1>
      <p>Add albums, singles, and unreleased original music. Drafts stay private until you sign the catalog license and the team verifies your rights.</p></header>
    {!signedIn ? <section className={styles.card}><h2>Sign in to begin</h2>
      <p>Your account keeps the drafts and audio together.</p><button onClick={signIn}>Sign in with Google</button></section>
      : <>
        <form className={styles.card} onSubmit={submit}>
          <h2>New release</h2>
          <label>Artist<select value={artistId} onChange={(e) => setArtistId(e.target.value)}>
            <option value="">Choose an artist</option>{artists.map((artist) => <option key={artist.id} value={artist.id}>{artist.name}</option>)}
          </select></label>
          <div className={styles.newArtist}><input aria-label="New artist name" maxLength={160} value={newArtistName}
            onChange={(e) => setNewArtistName(e.target.value)} placeholder="Artist not listed? Enter the name" />
            <button type="button" disabled={busy || !newArtistName.trim()} onClick={createArtist}>Create private artist draft</button></div>
          <p className={styles.hint}>If the artist is not listed, enter the name above. Saving the release will create its private artist draft.</p>
          <label>Release title<input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Album, EP, single, or collection" /></label>
          <div className={styles.row}><label>Original release date<input type="date" disabled={unreleased} value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className={styles.check}><input type="checkbox" checked={unreleased} onChange={(e) => setUnreleased(e.target.checked)} /> Unreleased collection</label></div>
          <label>Cover art (optional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setCover(e.target.files?.[0] ?? null)} /></label>
          <label>Audio files<input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.opus" multiple onChange={(e) => pickFiles(e.target.files)} /></label>
          {!!files.length && <div className={styles.trackEditor}><h3>Check the track list</h3>
            {files.map((row, index) => <div key={`${row.file.name}-${index}`} className={styles.fileRow}>
              <input aria-label={`Track number for ${row.file.name}`} type="number" min={1} max={999} value={row.number}
                onChange={(e) => setFiles((current) => current.map((item, i) => i === index ? { ...item, number: Number(e.target.value) } : item))} />
              <input aria-label={`Title for ${row.file.name}`} maxLength={200} value={row.name}
                onChange={(e) => setFiles((current) => current.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} />
              <small>{(row.file.size / 1024 / 1024).toFixed(1)} MB</small>
            </div>)}</div>}
          <p className={styles.hint}>{grants.some((grant) => grant.artist_id === artistId)
            ? `Verified artist capacity: 250 MB per file, ${Math.round(Number(grants.find((grant) => grant.artist_id === artistId)?.limit_bytes || 0) / 1024 ** 3)} GB total.`
            : "50 MB per file and 500 MB total until the team verifies your artist account."} Upload one release at a time. You can retry a failed file below.</p>
          <button disabled={busy}>{busy ? "Uploading…" : "Save private release"}</button>
        </form>
        {message && <p role="status" className={styles.message}>{message}</p>}
        <section className={styles.drafts}><div className={styles.draftsHead}><h2>Your release drafts</h2>
          <a href="/artist-upload">Sign and submit catalog →</a></div>
          {!releases.length && <p>No releases uploaded yet.</p>}
          {releases.map((release) => <article key={release.id} className={styles.card}>
            <small>{release.artist?.name} · {release.is_unreleased ? "Unreleased" : release.release_date || "Release date unknown"}</small>
            <h3>{release.name}</h3>
            {release.published_album_id ? <p>Published after rights review</p> : <p>{release.tracks.filter((track) => track.audio).length} of {release.tracks.length} audio files ready · {release.art_storage_path ? "Cover ready" : "No cover"}</p>}
            {!release.submitted_at && !release.published_album_id && <label className={styles.retry}>Add or replace cover
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy}
                onChange={(e) => { const file = e.target.files?.[0]; if (file) void retryCover(release.id, file); }} />
            </label>}
            <ol>{release.tracks.map((track) => <li key={track.id}>
              <span>{track.track_number}. {track.name}</span>
              {track.audio ? <em>Ready</em> : <label className={styles.retry}>Add audio
                <input type="file" accept="audio/*" disabled={busy || !!release.published_album_id}
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) void retry(track.id, release.artist_id, file); }} />
              </label>}
            </li>)}</ol>
          </article>)}
        </section>
      </>}
  </main>;
}
