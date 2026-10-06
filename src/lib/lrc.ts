// Validation for hand-timed lyrics. The client builds `[mm:ss.xx]text` lines;
// this is the server's check that what lands in tracks.lyrics_synced is
// something parseLRC() in public/index.html will read back line for line.

export const LRC_MAX_CHARS = 120_000;
export const LRC_MAX_LINES = 600;

export type LrcCheck =
  | { ok: true; lrc: string; lines: number }
  | { ok: false; error: string };

export function parseLrcStrict(input: string): LrcCheck {
  if (input.length > LRC_MAX_CHARS) return { ok: false, error: "That is too much text to be lyrics." };
  const out: string[] = [];
  let last = -1;
  for (const raw of input.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(/^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\](.*)$/);
    if (!m) return { ok: false, error: "Every line needs a time like [01:23.45]." };
    const secs = Number(m[1]) * 60 + Number(m[2]);
    if (!Number.isFinite(secs) || Number(m[2]) >= 60) return { ok: false, error: "A time is out of range." };
    if (secs < last) return { ok: false, error: "Line times have to go forward." };
    last = secs;
    out.push(`[${m[1].padStart(2, "0")}:${m[2].includes(".") ? m[2] : m[2] + ".00"}]${m[3].trim().slice(0, 300)}`);
  }
  if (!out.length) return { ok: false, error: "No timed lines found." };
  if (out.length > LRC_MAX_LINES) return { ok: false, error: "Too many lines." };
  return { ok: true, lrc: out.join("\n"), lines: out.length };
}
