/**
 * Deepgram Nova-3 for Artist Deep Dive transcripts.
 *
 * Ported from 69.studio's proven listen helpers: point Deepgram at a signed
 * audio URL, prefer paragraphs over utterances so long callbacks stay under
 * Vercel's ~4.5MB body limit, and use an async webhook for anything that
 * would hold a serverless invocation open too long.
 */

const LISTEN_URL = "https://api.deepgram.com/v1/listen";

export class DeepgramError extends Error {}

export type DeepgramCue = {
  start: number;
  end: number | null;
  text: string;
};

export type ParsedDeepgramTranscript = {
  body: string;
  cues: DeepgramCue[] | null;
  wordCount: number;
  requestId: string | null;
};

function apiKey(): string {
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) throw new DeepgramError("DEEPGRAM_API_KEY is not configured.");
  return key;
}

/** Query params shared by sync and async listens. */
function listenParams(extra?: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    punctuate: "true",
    paragraphs: "true",
    language: "en",
    ...extra,
  });
}

/**
 * Hand Deepgram a remote audio URL with an async callback. Returns immediately
 * with a request_id; the finished transcript arrives at callbackUrl.
 */
export async function submitDeepgramUrl(
  streamUrl: string,
  callbackUrl: string,
): Promise<{ requestId: string }> {
  let res: Response;
  try {
    res = await fetch(`${LISTEN_URL}?${listenParams({ callback: callbackUrl }).toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: streamUrl }),
      cache: "no-store",
    });
  } catch {
    throw new DeepgramError("Could not reach Deepgram.");
  }

  const body = (await res.json().catch(() => null)) as {
    request_id?: string;
    err_code?: string;
    err_msg?: string;
    message?: string;
  } | null;

  if (!res.ok) {
    const detail = body?.err_msg ?? body?.message ?? `HTTP ${res.status}`;
    throw new DeepgramError(`Deepgram refused the job: ${detail}`);
  }

  const requestId = body?.request_id;
  if (!requestId) throw new DeepgramError("Deepgram returned no request_id.");
  return { requestId };
}

/** Sync listen (no callback). Fine for short clips; not for hour-long shows. */
export async function transcribeDeepgramUrlSync(streamUrl: string): Promise<ParsedDeepgramTranscript> {
  let res: Response;
  try {
    res = await fetch(`${LISTEN_URL}?${listenParams().toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: streamUrl }),
      cache: "no-store",
    });
  } catch {
    throw new DeepgramError("Could not reach Deepgram.");
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (payload as { err_msg?: string; message?: string } | null)?.err_msg ??
      (payload as { message?: string } | null)?.message ??
      `HTTP ${res.status}`;
    throw new DeepgramError(`Deepgram refused the job: ${detail}`);
  }

  return parseDeepgramResponse(payload);
}

type DgWord = { word?: string; punctuated_word?: string; start?: number; end?: number };
type DgUtterance = { start?: number; end?: number; transcript?: string };
type DgSentence = { start?: number; end?: number; text?: string };
type DgParagraph = { start?: number; end?: number; sentences?: DgSentence[]; transcript?: string };
type DgAlt = {
  transcript?: string;
  words?: DgWord[];
  paragraphs?: { transcript?: string; paragraphs?: DgParagraph[] };
};
type DgResponse = {
  metadata?: { request_id?: string };
  results?: {
    utterances?: DgUtterance[];
    channels?: { alternatives?: DgAlt[] }[];
  };
};

function cuesFromParagraphs(alt: DgAlt | undefined): DeepgramCue[] | null {
  const paras = alt?.paragraphs?.paragraphs;
  if (!paras?.length) return null;
  const cues: DeepgramCue[] = [];
  for (const p of paras) {
    if (p.sentences?.length) {
      for (const s of p.sentences) {
        const text = String(s.text ?? "").trim();
        if (!text) continue;
        cues.push({
          start: Number(s.start ?? p.start ?? 0),
          end: s.end == null ? (p.end == null ? null : Number(p.end)) : Number(s.end),
          text,
        });
      }
    } else {
      const text = String(p.transcript ?? "").trim();
      if (!text) continue;
      cues.push({
        start: Number(p.start ?? 0),
        end: p.end == null ? null : Number(p.end),
        text,
      });
    }
  }
  return cues.length ? cues : null;
}

function cuesFromUtterances(utterances: DgUtterance[]): DeepgramCue[] | null {
  if (!utterances.length) return null;
  const cues = utterances
    .map((u) => ({
      start: Number(u.start ?? 0),
      end: u.end == null ? null : Number(u.end),
      text: String(u.transcript ?? "").trim(),
    }))
    .filter((c) => c.text);
  return cues.length ? cues : null;
}

function cuesFromWords(words: DgWord[]): DeepgramCue[] | null {
  if (!words.length) return null;
  const cues: DeepgramCue[] = [];
  let chunk: DeepgramCue = { start: Number(words[0]?.start ?? 0), end: null, text: "" };
  const buf: string[] = [];
  for (const w of words) {
    const start = Number(w.start ?? 0);
    if (buf.length && start - chunk.start > 8) {
      chunk.text = buf.join(" ");
      chunk.end = Number(w.start ?? chunk.start);
      cues.push(chunk);
      buf.length = 0;
      chunk = { start, end: null, text: "" };
    }
    buf.push(String(w.punctuated_word ?? w.word ?? "").trim());
    chunk.end = w.end == null ? null : Number(w.end);
  }
  if (buf.length) {
    chunk.text = buf.join(" ");
    cues.push(chunk);
  }
  return cues.length ? cues : null;
}

/** Turn a Deepgram listen payload into plain text (+ optional timed cues). */
export function parseDeepgramResponse(raw: unknown): ParsedDeepgramTranscript {
  const doc = raw as DgResponse;
  const alt = doc.results?.channels?.[0]?.alternatives?.[0];
  const utterances = doc.results?.utterances ?? [];

  let cues =
    cuesFromParagraphs(alt) ??
    cuesFromUtterances(utterances) ??
    (alt?.words?.length ? cuesFromWords(alt.words) : null);

  const body =
    alt?.paragraphs?.transcript?.trim() ||
    alt?.transcript?.trim() ||
    (cues ? cues.map((c) => c.text).join(" ") : "");

  if (!body) throw new DeepgramError("Deepgram returned an empty transcript.");
  if (cues && !cues.length) cues = null;

  return {
    body,
    cues,
    wordCount: body.split(/\s+/).filter(Boolean).length,
    requestId: doc.metadata?.request_id ?? null,
  };
}

export function deepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY?.trim());
}

/** Format cues as readable transcript lines for the Deep Dive detail card. */
export function formatCuesAsTranscript(cues: DeepgramCue[] | null, fallback: string): string {
  if (!cues?.length) return fallback;
  return cues.map((c) => c.text).join("\n");
}
