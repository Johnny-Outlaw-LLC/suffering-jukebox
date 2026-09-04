import { NextRequest, NextResponse } from "next/server";
import { JUKEBOX_SCHEMA, createSjServiceClient, getAuthUser } from "@/lib/sj-admin-auth";

export const dynamic = "force-dynamic";

// Client performance telemetry. The browser buffers everything sjPerf() records
// and posts only the interesting entries here -- stalls, long tasks, errors and
// slow renders. Freezes happen on phones, where there is no DevTools to read the
// in-memory log out of, which is the whole reason this route exists.
//
// Everything is sanitised on the way in: an event name has to match a known
// prefix, numeric fields are coerced to numbers, and the one free-text field is
// truncated. Nothing else from the payload reaches the table.

const MAX_ENTRIES = 60;
const MAX_MESSAGE = 300;

// Event names are a controlled vocabulary so one bad client build cannot fill
// the table with unbounded cardinality.
const ALLOWED_PREFIXES = [
  "browser.",
  "render.",
  "playlist-wall.",
  "now-playing.",
  "boot.",
];

// Only these keys survive from an entry's detail blob.
const NUMERIC_DETAIL_KEYS = [
  "durationMs",
  "startMs",
  // browser.page-load carries the Navigation Timing breakdown: the server
  // (ttfb), the first pixel (fcp), the document (dom/load), and the first heavy
  // render finishing (appReady), which is when the page stops looking empty.
  "ttfbMs",
  "domMs",
  "loadMs",
  "fcpMs",
  "appReadyMs",
  "transferKb",
  "rows",
  "tracks",
  "albums",
  "artists",
  "items",
  "count",
  "chunk",
  "ms",
];

type IncomingEntry = Record<string, unknown>;

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function allowedEvent(event: string): boolean {
  return ALLOWED_PREFIXES.some((p) => event.startsWith(p));
}

function cleanDetail(entry: IncomingEntry): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const key of NUMERIC_DETAIL_KEYS) {
    const n = num(entry[key]);
    if (n !== null) detail[key] = n;
  }
  if (typeof entry.message === "string" && entry.message.trim()) {
    detail.message = entry.message.slice(0, MAX_MESSAGE);
  }
  if (typeof entry.label === "string" && entry.label.trim()) {
    detail.label = entry.label.slice(0, 80);
  }
  return detail;
}

export async function POST(req: NextRequest) {
  let body: {
    sessionId?: string;
    userAgent?: string;
    path?: string;
    viewport?: { width?: unknown; height?: unknown; dpr?: unknown };
    entries?: IncomingEntry[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad JSON." }, { status: 400 });
  }

  const sessionId = String(body.sessionId || "").trim().slice(0, 64);
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "Missing session." }, { status: 400 });
  }

  const entries = Array.isArray(body.entries) ? body.entries.slice(0, MAX_ENTRIES) : [];
  if (!entries.length) return NextResponse.json({ ok: true, written: 0 });

  const viewport = body.viewport
    ? {
        width: int(body.viewport.width),
        height: int(body.viewport.height),
        dpr: num(body.viewport.dpr),
      }
    : null;

  const userAgent = String(body.userAgent || req.headers.get("user-agent") || "").slice(0, 400);
  const path = String(body.path || "").slice(0, 200);

  // Signed in is a nice-to-have here, not a requirement -- most freezes are
  // reported by signed-out visitors and those are exactly as worth seeing.
  const user = await getAuthUser(req).catch(() => null);

  const rows = entries
    .map((entry) => {
      const event = String(entry.event || "").trim().slice(0, 80);
      if (!event || !allowedEvent(event)) return null;
      return {
        session_id: sessionId,
        user_id: user?.id || null,
        email: user?.email || null,
        event,
        page_ms: int(entry.pageMs),
        duration_ms: num(entry.durationMs),
        heap_used_mb: int(entry.heapUsedMB),
        heap_total_mb: int(entry.heapTotalMB),
        detail: cleanDetail(entry),
        user_agent: userAgent || null,
        viewport,
        path: path || null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (!rows.length) return NextResponse.json({ ok: true, written: 0 });

  try {
    const sb = createSjServiceClient();
    const { error } = await sb.schema(JUKEBOX_SCHEMA).from("perf_events").insert(rows);
    if (error) throw error;
  } catch (e) {
    console.error("[sj-perf]", e);
    // A telemetry failure must never surface to the visitor as an error, so the
    // client ignores the status. 500 is here for the server logs only.
    return NextResponse.json({ ok: false, error: "Log failed." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, written: rows.length });
}
