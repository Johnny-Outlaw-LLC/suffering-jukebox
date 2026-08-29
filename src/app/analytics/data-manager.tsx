"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./analytics.module.css";

type Source = "spotify" | "jukebox";
type Batch = { source: Source; year: number; activeRecords: number; pendingDeletionRecords: number };
type Selection = { source: Source; year: number };

function format(value: number) { return new Intl.NumberFormat().format(value); }
function sourceLabel(source: Source) { return source === "spotify" ? "Spotify" : "Suffering Jukebox"; }

export default function DataManager({ accessToken, onChange }: { accessToken: string; onChange: () => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/spotify/history", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action: "data-batches" }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.ok) throw new Error(json.error || "Could not load your listening data.");
      setBatches(Array.isArray(json.data?.batches) ? json.data.batches : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your listening data.");
    } finally { setLoading(false); }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const selectedBatches = useMemo(() => batches.filter(batch => selected.has(`${batch.source}:${batch.year}`)), [batches, selected]);
  const selectedRecords = useMemo(() => selectedBatches.reduce((total, batch) => total + batch.activeRecords, 0), [selectedBatches]);
  const activeBatches = useMemo(() => batches.filter(batch => batch.activeRecords > 0), [batches]);
  const totalActive = useMemo(() => activeBatches.reduce((total, batch) => total + batch.activeRecords, 0), [activeBatches]);

  function toggle(batch: Batch) {
    const key = `${batch.source}:${batch.year}`;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function updateArchive(action: "archive-data-batches" | "restore-data-batches", rows: Selection[]) {
    if (!rows.length) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/spotify/history", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action, batches: rows }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.ok) throw new Error(json.error || "Could not update your listening data.");
      const count = Number(json.result?.records || 0);
      setBatches(Array.isArray(json.data?.batches) ? json.data.batches : []);
      setSelected(new Set());
      setNotice(action === "archive-data-batches"
        ? `${format(count)} record${count === 1 ? "" : "s"} marked for deletion. They will be permanently removed after 30 days.`
        : `${format(count)} record${count === 1 ? "" : "s"} restored to your Analytics.`);
      onChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update your listening data.");
    } finally { setSaving(false); }
  }

  function archiveSelected() {
    if (!selectedBatches.length || saving) return;
    const description = selectedBatches.map(batch => `${sourceLabel(batch.source)} ${batch.year}`).join(", ");
    if (!window.confirm(`Mark ${format(selectedRecords)} listening record${selectedRecords === 1 ? "" : "s"} (${description}) for deletion? They will disappear from Analytics now and be permanently removed after 30 days.`)) return;
    void updateArchive("archive-data-batches", selectedBatches.map(({ source, year }) => ({ source, year })));
  }

  return <section className={styles.dataManager} aria-labelledby="manage-my-data-title">
    <div className={styles.dataManagerIntro}>
      <div><p className={styles.eyebrow}>Privacy controls</p><h2 id="manage-my-data-title">Manage my data</h2><p>Choose listening-history batches to remove from your Analytics. This affects only your Spotify history and Suffering Jukebox play records—not playlists, saved music, or your account.</p></div>
      <div className={styles.dataManagerTotal}><span>Active listening records</span><strong>{format(totalActive)}</strong></div>
    </div>
    <div className={styles.retentionNotice}><strong>30-day recovery window</strong><span>Marked records are hidden immediately and remain recoverable here for 30 days before permanent deletion.</span></div>
    {error && <div className={styles.error}>{error}</div>}
    {notice && <div className={styles.success}><p>{notice}</p></div>}
    {loading ? <div className={styles.loading}>Loading your listening-data batches…</div> : !batches.length ? <div className={styles.emptyData}><h3>No listening records yet</h3><p>Import Spotify history or listen in the Jukebox to see your records here.</p></div> : <>
      <div className={styles.dataToolbar}>
        <p>{selectedBatches.length ? `${format(selectedRecords)} records in ${selectedBatches.length} selected batch${selectedBatches.length === 1 ? "" : "es"}` : "Select one or more year-and-source batches to mark them for deletion."}</p>
        <div><button className={styles.secondaryButton} disabled={saving || !activeBatches.length} onClick={() => setSelected(new Set(activeBatches.map(batch => `${batch.source}:${batch.year}`)))}>Select all</button><button className={styles.secondaryButton} disabled={saving || !selected.size} onClick={() => setSelected(new Set())}>Clear</button></div>
      </div>
      <div className={styles.dataBatchList}>
        {batches.map(batch => {
          const key = `${batch.source}:${batch.year}`;
          const selectable = batch.activeRecords > 0;
          return <div className={`${styles.dataBatch} ${batch.source === "spotify" ? styles.spotifyBatch : styles.jukeboxBatch}`} key={key}>
            <label>
              <input className={styles.selectionCheckbox} type="checkbox" checked={selected.has(key)} disabled={!selectable || saving} onChange={() => toggle(batch)} />
              <span className={styles.batchSource}>{sourceLabel(batch.source)}</span><strong>{batch.year}</strong>
            </label>
            <div className={styles.batchCounts}><span><b>{format(batch.activeRecords)}</b> active</span>{batch.pendingDeletionRecords > 0 && <span className={styles.pendingCount}><b>{format(batch.pendingDeletionRecords)}</b> pending deletion</span>}</div>
            {batch.pendingDeletionRecords > 0 && <button className={styles.secondaryButton} disabled={saving} onClick={() => void updateArchive("restore-data-batches", [{ source: batch.source, year: batch.year }])}>Restore</button>}
          </div>;
        })}
      </div>
      <div className={styles.dataActions}><button className={styles.dangerButton} disabled={!selectedBatches.length || saving} onClick={archiveSelected}>{saving ? "Updating…" : selectedBatches.length ? `Mark ${format(selectedRecords)} for deletion` : "Mark for deletion"}</button></div>
    </>}
  </section>;
}
