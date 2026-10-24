"use client";

/**
 * Step 3: the catalog license, which used to be its own page at
 * /artist-upload. Every declaration and the typed signature are unchanged and
 * still asked for each time; /api/sj-artist-rights decides what is required.
 * What changed is the order and the typing: a self-releasing artist answers
 * "who made this?" once instead of writing their own name into four ownership
 * fields, and the agreement leads with a plain summary of what it says.
 */

import { useEffect, useMemo, useState } from "react";
import { authHeaders } from "./client";
import { COUNTRIES } from "./countries";
import styles from "./upload.module.css";

type CatalogGroup = { artist: { id: string; name: string }; trackCount: number;
  tracks: Array<{ trackId: string; trackName: string; albumName: string }> };
type Application = { id: string; status: string; stage_name: string; signed_at: string; review_note: string | null;
  trackCount: number; approvedTrackCount: number; artist: { name: string } | null };
type Submission = Record<string, string | null>;
export type RightsData = {
  catalog: CatalogGroup[];
  applications: Application[];
  lastSubmission: Submission | null;
  agreement: { version: string; sha256: string; contact: string; sections: Array<{ title: string; body: string }> } | null;
};

const SELF_ROLE = "Self-releasing artist and rights owner";
const OTHER_ROLES = ["Authorized band representative", "Authorized label representative", "Authorized manager or attorney"];

/** The wording is the old form's, verbatim: these are what the artist affirms. */
const DECLARATIONS: Array<[string, string]> = [
  ["ownsSoundRecordings", "I own or have written authority over every submitted master sound recording."],
  ["controlsCompositions", "I own or have written authority over the underlying music and lyrics, including all co-writer and publisher shares needed for this license."],
  ["clearedContributors", "Performers, producers, featured artists, engineers, and other contributors have been cleared for this use."],
  ["clearedSamples", "The recordings contain no uncleared samples, interpolations, beats, or third-party audio."],
  ["clearedArtwork", "I may authorize display of the supplied artist name, credits, images, and artwork."],
  ["originalCatalogOnly", "This self-service submission contains original songs only, with no covers or arrangements of somebody else’s composition."],
];
const LICENSE_CONFIRMATIONS: Array<[string, string]> = [
  ["grantConfirmed", "I grant the nonexclusive on-demand streaming license stated above."],
  ["dmcaConfirmed", "I accept the copyright-notice and repeat-infringer process in the Terms."],
  ["accurateInformationConfirmed", "I certify that this submission is complete and accurate and understand that false claims can lead to removal or account termination."],
];

const STATUS_LABEL: Record<string, string> = {
  pending: "In review", approved: "Live", rejected: "Not approved", suspended: "Paused", withdrawn: "Withdrawn", revoked: "Withdrawn",
};

const EMPTY = { legalName: "", stageName: "", organization: "", authorityRole: "", country: "", contactPhone: "", website: "",
  catalogDescription: "", masterOwner: "", compositionOwner: "", writers: "", publishers: "", rightsNotes: "", signedName: "" };

export default function GoPublic({ rights, busyArtists, userName, onChanged }: {
  rights: RightsData | null; busyArtists: Set<string>; userName: string; onChanged: () => void;
}) {
  const catalog = useMemo(() => rights?.catalog ?? [], [rights]);
  const [artistId, setArtistId] = useState("");
  const [open, setOpen] = useState(false);
  const [madeByMe, setMadeByMe] = useState(true);
  const [form, setForm] = useState({ ...EMPTY });
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<{ tone: "ok" | "bad" | ""; text: string }>({ tone: "", text: "" });
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const preferred = new URLSearchParams(location.search).get("artist");
    if (preferred && catalog.some((g) => g.artist.id === preferred)) { setArtistId(preferred); setOpen(true); }
    else if (!artistId && catalog.length === 1) setArtistId(catalog[0].artist.id);
  }, [catalog, artistId]);

  // A returning artist is the same person with the same ownership story; only
  // the declarations and the signature are asked for again.
  useEffect(() => {
    const prev = rights?.lastSubmission;
    setForm((f) => {
      const next = { ...f };
      if (prev) for (const key of Object.keys(EMPTY) as Array<keyof typeof EMPTY>) {
        const value = prev[key];
        if (!next[key] && value && key !== "signedName" && (key !== "country" || COUNTRIES.includes(value))) next[key] = value;
      }
      if (!next.legalName && userName) next.legalName = userName;
      return next;
    });
    if (prev?.authorityRole) setMadeByMe(prev.authorityRole === SELF_ROLE);
  }, [rights, userName]);

  const group = catalog.find((g) => g.artist.id === artistId);
  useEffect(() => { if (group) setForm((f) => ({ ...f, stageName: f.stageName || group.artist.name })); }, [group]);

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const allChecked = [...DECLARATIONS, ...LICENSE_CONFIRMATIONS].every(([key]) => checks[key]);
  const signatureOk = !!form.signedName.trim() && form.signedName.trim().toLowerCase() === form.legalName.trim().toLowerCase();
  const busy = group ? busyArtists.has(group.artist.id) : false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!group) return;
    if (!signatureOk) { setResult({ tone: "bad", text: "Your signature has to match your legal name exactly." }); return; }
    const legal = form.legalName.trim();
    const body: Record<string, unknown> = {
      ...form, ...checks, artistId: group.artist.id,
      ...(madeByMe ? {
        authorityRole: SELF_ROLE, organization: "",
        masterOwner: legal, compositionOwner: legal, writers: legal, publishers: "None, self-published",
        catalogDescription: form.catalogDescription.trim()
          || `Original music written, recorded and owned by ${legal}, released as ${form.stageName.trim() || group.artist.name}.`,
      } : {}),
    };
    setSending(true);
    setResult({ tone: "", text: "Signing and sending for review…" });
    try {
      const r = await fetch("/api/sj-artist-rights", { method: "POST",
        headers: { "Content-Type": "application/json", ...await authHeaders() }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || "Could not send it. Try again.");
      setResult({ tone: "ok", text: `Sent. ${d.trackCount} songs are waiting for review. We check every submission by hand, and the status shows here.` });
      setOpen(false);
      setChecks({});
      setForm((f) => ({ ...f, signedName: "" }));
      onChanged();
    } catch (error) { setResult({ tone: "bad", text: (error as Error).message }); }
    finally { setSending(false); }
  }

  async function withdraw(id: string) {
    if (!confirm("Withdraw this license? Public streaming of these songs stops right away.")) return;
    const r = await fetch("/api/sj-artist-rights", { method: "PATCH",
      headers: { "Content-Type": "application/json", ...await authHeaders() }, body: JSON.stringify({ agreementId: id, action: "withdraw" }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { alert(d.error || "Could not withdraw."); return; }
    onChanged();
  }

  const agreement = rights?.agreement;
  return <section id="go-public" className={styles.section}>
    <h2 className={styles.stepTitle}><b>3</b> Go public</h2>
    {!rights && <p className={styles.muted}>Loading…</p>}
    {rights && !catalog.length && <p className={styles.muted}>When a release has all its audio, it shows up here, ready to go public.</p>}

    {!!catalog.length && <div className={styles.card}>
      <label className={styles.field}>Ready to go public
        <select value={artistId} onChange={(e) => { setArtistId(e.target.value); setOpen(false); }}>
          <option value="">Choose an artist</option>
          {catalog.map((g) => <option key={g.artist.id} value={g.artist.id}>{g.artist.name} · {g.trackCount} song{g.trackCount === 1 ? "" : "s"}</option>)}
        </select></label>
      {group && <>
        <p className={styles.muted}>{[...new Set(group.tracks.map((t) => t.albumName))].join(", ")}</p>
        {busy && <p className={styles.warn}>Some of these songs are still uploading. You can fill this in now and send it when they finish.</p>}
        {!open && <div className={styles.actions}><button className={styles.primary} onClick={() => setOpen(true)}>Go public with {group.artist.name}</button></div>}
      </>}
    </div>}

    {group && open && <form className={styles.card} onSubmit={submit}>
      <h3>Who made this music?</h3>
      <div className={styles.choice}>
        <label className={madeByMe ? styles.chosen : ""}><input type="radio" checked={madeByMe} onChange={() => setMadeByMe(true)} />
          <span><strong>I did.</strong> I wrote it, recorded it and own it. No label or publisher.</span></label>
        <label className={!madeByMe ? styles.chosen : ""}><input type="radio" checked={!madeByMe} onChange={() => setMadeByMe(false)} />
          <span><strong>Someone I represent</strong>: my band, a label, or an artist I manage.</span></label>
      </div>

      <div className={styles.grid}>
        <label className={styles.field}>Your full legal name<input value={form.legalName} onChange={set("legalName")} maxLength={160} required autoComplete="name" /></label>
        <label className={styles.field}>Artist or band name<input value={form.stageName} onChange={set("stageName")} maxLength={160} required /></label>
        <label className={styles.field}>Country<select value={form.country} onChange={set("country")} required autoComplete="country-name">
          <option value="">Choose one</option><option>United States</option>
          {COUNTRIES.filter((c) => c !== "United States").map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className={styles.field}>Phone<input value={form.contactPhone} onChange={set("contactPhone")} maxLength={80} required autoComplete="tel" />
          <small className={styles.muted}>Only used if the review needs to reach you.</small></label>
        <label className={`${styles.field} ${styles.full}`}>A page that shows this is you
          <input type="url" value={form.website} onChange={set("website")} maxLength={500} placeholder="https://" required />
          <small className={styles.muted}>Your website, Bandcamp, Instagram or any profile with your music on it.</small></label>
        {!madeByMe && <>
          <label className={styles.field}>Your role<select value={OTHER_ROLES.includes(form.authorityRole) ? form.authorityRole : ""} onChange={set("authorityRole")} required>
            <option value="">Choose one</option>{OTHER_ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
          <label className={styles.field}>Company or label, if any<input value={form.organization} onChange={set("organization")} maxLength={200} autoComplete="organization" /></label>
          <label className={styles.field}>Who owns the recordings?<input value={form.masterOwner} onChange={set("masterOwner")} maxLength={200} required /></label>
          <label className={styles.field}>Who owns the songs (music and lyrics)?<input value={form.compositionOwner} onChange={set("compositionOwner")} maxLength={200} required /></label>
          <label className={`${styles.field} ${styles.full}`}>Songwriters<textarea value={form.writers} onChange={set("writers")} maxLength={1000} required /></label>
          <label className={`${styles.field} ${styles.full}`}>Publishers, if any<textarea value={form.publishers} onChange={set("publishers")} maxLength={1000} placeholder="None, self-published" /></label>
          <label className={`${styles.field} ${styles.full}`}>How you control this catalog<textarea value={form.catalogDescription} onChange={set("catalogDescription")} maxLength={2000} required placeholder="Who made it, who owns it, and why you can license it." /></label>
        </>}
        <label className={`${styles.field} ${styles.full}`}>Anything we should know? (optional)
          <textarea value={form.rightsNotes} onChange={set("rightsNotes")} maxLength={2000} placeholder="Links, registrations, a co-writer's name, or other context." /></label>
      </div>
      {madeByMe && form.legalName.trim() && <p className={styles.muted}>We&apos;ll record {form.legalName.trim()} as the owner of the recordings and the songs, and as the songwriter, with no publisher.</p>}

      <h3>The agreement, in short</h3>
      <ul className={styles.summary}>
        <li>You keep ownership, and you can put the same music anywhere else.</li>
        <li>You let us stream it on demand on Suffering Jukebox and Listening Party, with your artwork and credits.</li>
        <li>No downloads for sale, ads, film, merch or AI training without a separate written deal.</li>
        <li>It&apos;s free both ways: no fees to us, and no royalties from us right now.</li>
        <li>Nothing goes live until we approve it, and you can withdraw any time.</li>
        <li>Original music only: no covers, uncleared samples, or recordings a label controls.</li>
        <li>If you send music you don&apos;t have the rights to, you&apos;re responsible for it.</li>
      </ul>
      {agreement && <details className={styles.fullText}><summary>Read the full agreement (version {agreement.version})</summary>
        {agreement.sections.map((s, i) => <section key={s.title}><h4>{i + 1}. {s.title}</h4><p>{s.body}</p></section>)}
        <p className={styles.muted}>SHA-256 {agreement.sha256} · <a href="/artist-agreement" target="_blank" rel="noopener">Printable copy</a></p>
      </details>}

      <h3>Confirm each one</h3>
      <div className={styles.checks}>
        {[...DECLARATIONS, ...LICENSE_CONFIRMATIONS].map(([key, text]) => <label key={key}>
          <input type="checkbox" checked={!!checks[key]} onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))} required />
          <span>{text}</span></label>)}
      </div>

      <label className={styles.field}>Sign by typing your full legal name
        <input value={form.signedName} onChange={set("signedName")} maxLength={160} required autoComplete="off" placeholder={form.legalName} />
        {form.signedName && !signatureOk && <small className={styles.failed}>This has to match your legal name above.</small>}</label>
      <p className={styles.muted}>Signing records your account, email, the agreement version, your answers, the time and your browser details. Questions? <a href={`mailto:${agreement?.contact ?? "support@outlawapps.online"}`}>{agreement?.contact ?? "support@outlawapps.online"}</a></p>
      <div className={styles.actions}>
        <button className={styles.primary} disabled={sending || busy || !allChecked || !signatureOk}>{busy ? "Waiting for uploads to finish…" : sending ? "Sending…" : "Sign and send for review"}</button>
        <button type="button" className={styles.secondary} onClick={() => setOpen(false)}>Not now</button>
      </div>
    </form>}

    {result.text && <p role="status" className={result.tone === "bad" ? styles.warn : styles.notice}>{result.text}</p>}

    {!!rights?.applications.length && <div className={styles.card}>
      <h3>What you&apos;ve sent</h3>
      <ul className={styles.apps}>{rights.applications.map((a) => <li key={a.id}>
        <div><strong>{a.artist?.name || a.stage_name}</strong>
          <small className={styles.muted}>{a.trackCount} songs · signed {new Date(a.signed_at).toLocaleDateString()}</small>
          {a.review_note && <small>Note from the review: {a.review_note}</small>}</div>
        <span className={`${styles.pill} ${styles[a.status === "approved" ? "live" : a.status === "pending" ? "review" : "warn"]}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
        {["pending", "approved", "suspended"].includes(a.status) && <button className={styles.linkButton} onClick={() => withdraw(a.id)}>Withdraw</button>}
      </li>)}</ul>
    </div>}
  </section>;
}
