"use client";

import { useEffect, useRef, useState } from "react";
import type { MissingSong } from "../analytics/import-missing";
import styles from "./demo.module.css";

export default function DemoImport({ songs, initialSelected = [], onClose, onImported, modal = false }: {
  songs: MissingSong[]; initialSelected?: string[]; onClose?: () => void;
  onImported?: (keys: string[]) => void; modal?: boolean;
}) {
  const [selected, setSelected] = useState(() => new Set(initialSelected));
  const [step, setStep] = useState(1);
  const [addedCount, setAddedCount] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const chosen = songs.filter(song => selected.has(song.key));
  useEffect(() => {
    if (!modal) return;
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => before?.focus();
  }, [modal]);
  const body = <div ref={root} tabIndex={-1} className={modal ? styles.dialog : styles.panel}
    role={modal ? "dialog" : undefined} aria-modal={modal || undefined} aria-label="Demo catalog import"
    onKeyDown={e => {
      if (e.key === "Escape") onClose?.();
      if (e.key !== "Tab" || !modal) return;
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>('button,input,[tabindex="0"]') || [])].filter(el => !el.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1)!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { e.preventDefault(); first.focus(); }
    }}>
    <span className={styles.badge}>Fictional demo · nothing is saved</span>
    <h2>Bring your history into your collection</h2>
    <p>These sample listening records contain music the demo catalog does not have yet. Try the choose, match, review, and add flow.</p>
    <ol className={styles.steps}>{["Choose songs", "Find matches", "Check the matches", "Add them"].map((label, i) => <li key={label} className={step === i + 1 ? styles.active : ""}>{i + 1}. {label}</li>)}</ol>
    {step === 1 && songs.map(song => <label className={styles.track} key={song.key}>
      <input className={styles.check} type="checkbox" checked={selected.has(song.key)} onChange={() => setSelected(current => {
        const next = new Set(current); if (next.has(song.key)) next.delete(song.key); else next.add(song.key); return next;
      })} />
      <div><strong>{song.title}</strong><small>{song.artist}</small></div><span>From imported history</span>
    </label>)}
    {step === 2 && <p className={styles.status}>The demo found fictional source matches for {chosen.length} song{chosen.length === 1 ? "" : "s"}. In your account, this step searches YouTube.</p>}
    {step === 3 && chosen.map(song => <div className={styles.track} key={song.key}><div><strong>{song.title}</strong><small>{song.artist} · sample source match</small></div><span>Ready for review</span></div>)}
    {step === 4 && <p className={styles.status} role="status">Added {addedCount} song{addedCount === 1 ? "" : "s"} to this demo collection. Your account and the public catalog have not changed.</p>}
    <div className={styles.actions}>
      {step === 1 && <><button className={styles.button} onClick={() => setSelected(new Set(songs.map(s => s.key)))}>Select all</button><button className={`${styles.button} ${styles.primary}`} disabled={!chosen.length} onClick={() => setStep(2)}>Find matches</button></>}
      {step === 2 && <button className={`${styles.button} ${styles.primary}`} onClick={() => setStep(3)}>Check the matches</button>}
      {step === 3 && <button className={`${styles.button} ${styles.primary}`} onClick={() => { setAddedCount(chosen.length); onImported?.(chosen.map(s => s.key)); setStep(4); }}>Add {chosen.length} songs to demo</button>}
      {step === 4 && !modal && <button className={styles.button} onClick={() => { setStep(1); setSelected(new Set()); }}>Try again</button>}
      {onClose && <button className={styles.button} onClick={onClose}>{step === 4 ? "Return to stats" : "Close"}</button>}
    </div>
  </div>;
  return modal ? <div className={styles.scrim}>{body}</div> : body;
}
