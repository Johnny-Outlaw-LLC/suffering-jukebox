import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, isSjAdmin, JUKEBOX_SCHEMA } from "@/lib/sj-admin-auth";

/**
 * The last test run plus the history behind it, for the admin Test Coverage page.
 *
 * test-results.json is deliberately NOT in public/. It names every check, every
 * module they reach and every gap they do not, which is a map of the app's soft
 * spots; the page that reads it says Restricted, and a file under public/ would
 * have been readable by anyone who guessed the path. next.config.ts traces it
 * into the bundle so the standalone build can still read it from disk.
 *
 * The history comes from jukebox.test_runs instead, because the file is
 * rewritten on every build and so can only ever describe the current commit.
 */
export const dynamic = "force-dynamic";

/** Six months of squares is a calendar somebody can actually read. */
const HISTORY_DAYS = 180;
const HISTORY_LIMIT = 2000;

type RunRow = {
  ran_at: string;
  commit_sha: string | null;
  branch: string | null;
  subject: string | null;
  source: string;
  dirty: boolean;
  wall_ms: number | null;
  suites: number;
  tests: number;
  passed: number;
  failed: number;
  failures: { suite: string; name: string; error: string | null }[] | null;
};

async function history() {
  try {
    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    const { data, error } = await createSjServiceClient()
      .schema(JUKEBOX_SCHEMA)
      .from("test_runs")
      .select("ran_at,commit_sha,branch,subject,source,dirty,wall_ms,suites,tests,passed,failed,failures")
      .gte("ran_at", since)
      .order("ran_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []) as RunRow[];
  } catch (err) {
    // A calendar that cannot load is not a reason to withhold the run that can.
    console.error("[sj-admin-tests] history", (err as Error).message);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email || !(await isSjAdmin(user.email))) {
    return NextResponse.json({ ok: false, error: "Administrator access required." }, { status: 403 });
  }

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(readFileSync(join(process.cwd(), "test-results.json"), "utf-8"));
  } catch {
    return NextResponse.json(
      { ok: false, error: "No results have been generated yet. Run npm test and commit test-results.json." },
      { status: 404 },
    );
  }

  const runs = await history();
  return NextResponse.json(
    { ...report, history: runs ?? [], historyAvailable: runs !== null, historyDays: HISTORY_DAYS },
    { headers: { "Cache-Control": "no-store" } },
  );
}
