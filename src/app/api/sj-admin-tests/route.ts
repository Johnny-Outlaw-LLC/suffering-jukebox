import { readFileSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, isSjAdmin } from "@/lib/sj-admin-auth";

/**
 * The last test run, for the admin Test Coverage page.
 *
 * test-results.json is deliberately NOT in public/. It names every check, every
 * module they reach and every gap they do not, which is a map of the app's soft
 * spots; the page that reads it says Restricted, and a file under public/ would
 * have been readable by anyone who guessed the path. next.config.ts traces it
 * into the bundle so the standalone build can still read it from disk.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email || !(await isSjAdmin(user.email))) {
    return NextResponse.json({ ok: false, error: "Administrator access required." }, { status: 403 });
  }
  try {
    const report = readFileSync(join(process.cwd(), "test-results.json"), "utf-8");
    return new NextResponse(report, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "No results have been generated yet. Run npm test and commit test-results.json." },
      { status: 404 },
    );
  }
}
