#!/usr/bin/env node
/**
 * The test runner behind /test-coverage.
 *
 * Runs every tests/*.test.mjs through node:test, then writes the whole run to
 * test-results.json: one entry per suite, one line per test, with the header
 * metadata each test file declares about itself (@suite, @area, @covers) and
 * the honest list of gaps in tests/coverage-gaps.json.
 *
 * That file is COMMITTED, and it sits at the repository root rather than under
 * public/ - the page that reads it is admin only, and it is served through
 * /api/sj-admin-tests. Nothing runs in the browser, so what production shows is
 * the result of the run that shipped the code, which is the only run that says
 * anything about what is deployed. Re-run this before pushing:
 *
 *     npm test
 *
 * It also runs as `prebuild`, so a Vercel deployment regenerates the report from
 * the commit it is building - which is why the page can say whether the results
 * it is showing describe the code being served. `--no-fail` is passed there:
 * failing tests turn the page red, they do not stop the deploy.
 *
 * Every run is also recorded as one row in jukebox.test_runs, which is what the
 * calendar on that page is built from. See recordRun().
 *
 * Exit code is otherwise the run's: non-zero when anything failed, for a hook.
 */
import { run } from 'node:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'tests');
// Deliberately NOT under public/: this file names every check and every gap,
// and the page that reads it is admin only. /api/sj-admin-tests serves it.
const OUT = join(root, 'test-results.json');
const SUPABASE_URL = 'https://ntyvtpimesfoesuykuyi.supabase.co';

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

/** What a test file says about itself in its header comment. */
function readHeader(file) {
  const text = readFileSync(join(testsDir, file), 'utf8');
  const meta = { suite: file.replace(/\.test\.mjs$/, ''), area: 'Unsorted', covers: '', description: '' };
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/\s?/, ''));
  }
  const prose = [];
  for (const line of lines) {
    const tag = line.match(/^@(suite|area|covers)\s+(.*)$/);
    if (tag) { meta[tag[1]] = tag[2].trim(); continue; }
    prose.push(line);
  }
  meta.description = prose.join('\n').replace(/^\s+|\s+$/g, '');
  return meta;
}

const suites = new Map();
for (const file of files) {
  suites.set('tests/' + file, { file: 'tests/' + file, ...readHeader(file), tests: [], passed: 0, failed: 0, durationMs: 0 });
}

function suiteFor(filePath) {
  if (!filePath) return null;
  const key = 'tests/' + filePath.replace(/\\/g, '/').split('/').pop();
  return suites.get(key) ?? null;
}

const startedAt = Date.now();
let failures = 0;

const stream = run({
  files: files.map((f) => join(testsDir, f)),
  concurrency: true,
});

// Consumed by iteration rather than by event listeners: node:test's stream is a
// readable, and listening for the named events alone never drains it, so the
// run finishes and 'end' is never reached.
for await (const event of stream) {
  if (event.type === 'test:pass') record(event.data, 'pass');
  else if (event.type === 'test:fail') record(event.data, 'fail');
}

function record(data, status) {
  // node:test emits a result for the FILE as well as for each test in it. The
  // file-level one carries no assertions of its own, so counting it would
  // inflate every total by one per suite.
  if (data.nesting !== 0 || data.name.endsWith('.test.mjs')) return;
  const suite = suiteFor(data.file);
  if (!suite) return;
  const durationMs = Math.round((data.details?.duration_ms ?? 0) * 100) / 100;
  const error = status === 'fail' ? errorText(data.details?.error) : null;
  suite.tests.push({ name: data.name, status, durationMs, error });
  suite.durationMs = Math.round((suite.durationMs + durationMs) * 100) / 100;
  if (status === 'pass') suite.passed++;
  else { suite.failed++; failures++; }
}

/** The first useful line of a failure, without a stack the page cannot use. */
function errorText(err) {
  if (!err) return 'failed';
  const cause = err.cause ?? err;
  const message = String(cause?.message ?? cause ?? 'failed');
  return message.split('\n').slice(0, 12).join('\n').slice(0, 2000);
}

/**
 * Which commit this run describes.
 *
 * On Vercel there is no .git, but the build environment names the commit, and
 * the run happens during that build - so the report describes exactly the code
 * being deployed. Locally it falls back to asking git, where the answer is HEAD
 * plus whatever is still uncommitted.
 */
function gitInfo() {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const env = process.env;
  if (env.VERCEL_GIT_COMMIT_SHA) {
    return {
      sha: env.VERCEL_GIT_COMMIT_SHA.slice(0, 12),
      branch: env.VERCEL_GIT_COMMIT_REF || '',
      subject: (env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0],
      committedAt: '',
      // Nothing is uncommitted in a build: it is a checkout of that one commit.
      dirty: false,
    };
  }
  return {
    sha: git(['rev-parse', 'HEAD']).slice(0, 12),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    subject: git(['log', '-1', '--pretty=%s']),
    committedAt: git(['log', '-1', '--pretty=%cI']),
    dirty: git(['status', '--porcelain']).length > 0,
  };
}

function readGaps() {
  try {
    return JSON.parse(readFileSync(join(testsDir, 'coverage-gaps.json'), 'utf8'));
  } catch {
    return [];
  }
}

/** Vercel has it in the environment; locally it is in one of a few .env files. */
function serviceRoleKey() {
  const fromEnv = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (fromEnv) return fromEnv;
  for (const rel of ['.env.local', '../env.local', '../.env.local']) {
    try {
      const line = readFileSync(join(root, rel), 'utf8')
        .split(/\r?\n/)
        .find((l) => /^\s*(export\s+)?SUPABASE_SERVICE_ROLE_KEY\s*=/.test(l));
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Keep one row per run in jukebox.test_runs, which is the whole of the calendar
 * on the Test Coverage page.
 *
 * test-results.json only ever describes the CURRENT run - the build rewrites it
 * every time - so history has to live somewhere that survives a deploy.
 * Deliberately not the whole report: totals, the per-area split and what
 * actually failed are what a calendar needs, and keeping every test name for
 * every run forever would grow without bound.
 *
 * Never fatal. A run that cannot reach the database has still told you
 * everything it found, and failing a build over the bookkeeping would be worse
 * than losing one square on a calendar.
 */
async function recordRun(result) {
  const key = serviceRoleKey();
  if (!key) {
    console.log('no service role key in the environment, so this run was not recorded');
    return;
  }
  const failed = [];
  for (const suite of result.suites) {
    for (const t of suite.tests) {
      if (t.status === 'fail') failed.push({ suite: suite.suite, name: t.name, error: t.error });
    }
  }
  const row = {
    ran_at: result.generatedAt,
    commit_sha: result.git.sha || null,
    branch: result.git.branch || null,
    subject: result.git.subject || null,
    node: result.node,
    source: process.env.VERCEL_GIT_COMMIT_SHA ? 'build' : 'local',
    dirty: !!result.git.dirty,
    wall_ms: result.wallMs,
    suites: result.totals.suites,
    tests: result.totals.tests,
    passed: result.totals.passed,
    failed: result.totals.failed,
    areas: result.areas,
    failures: failed,
  };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/test_runs`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'jukebox',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log('recorded this run in jukebox.test_runs');
  } catch (err) {
    console.warn(`could not record the run (${err.message}) - the results above still stand`);
  }
}

async function report() {
  const list = [...suites.values()].filter((s) => s.tests.length || s.failed);
  for (const suite of list) suite.tests.sort((a, b) => a.name.localeCompare(b.name));
  list.sort((a, b) => (a.area + a.suite).localeCompare(b.area + b.suite));

  const tests = list.reduce((n, s) => n + s.tests.length, 0);
  const passed = list.reduce((n, s) => n + s.passed, 0);
  const failed = list.reduce((n, s) => n + s.failed, 0);

  const areas = [...new Set(list.map((s) => s.area))].sort().map((area) => {
    const inArea = list.filter((s) => s.area === area);
    return {
      area,
      suites: inArea.length,
      tests: inArea.reduce((n, s) => n + s.tests.length, 0),
      failed: inArea.reduce((n, s) => n + s.failed, 0),
    };
  });

  const result = {
    generatedAt: new Date().toISOString(),
    wallMs: Date.now() - startedAt,
    node: process.version,
    git: gitInfo(),
    totals: { suites: list.length, tests, passed, failed },
    areas,
    suites: list,
    gaps: readGaps(),
  };

  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  const label = failed ? `${failed} FAILED` : 'all passing';
  console.log(`${tests} tests in ${list.length} suites, ${label} (${result.wallMs}ms)`);
  console.log(`wrote ${OUT.replace(root, '.')}`);
  if (failed) {
    for (const suite of list) {
      for (const t of suite.tests.filter((t) => t.status === 'fail')) {
        console.error(`\n  ${suite.suite} > ${t.name}\n    ${t.error?.split('\n')[0] ?? ''}`);
      }
    }
  }

  await recordRun(result);

  // --no-fail is how the build runs it. The page's job is to REPORT a failure in
  // red, not to stop a deploy: a red Test Coverage page is more useful than a
  // deployment that never happened, and the pre-push hook is where a gate
  // belongs. Run without it and the exit code is the run's, so it works in one.
  process.exitCode = failures && !process.argv.includes('--no-fail') ? 1 : 0;
}

await report();
