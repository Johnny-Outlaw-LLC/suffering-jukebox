// @suite Run history and the calendar
// @area Admin
// @covers scripts/run-tests.mjs recordRun, src/app/api/sj-admin-tests/route.ts,
//         the calendar in public/test-coverage/index.html
//
// test-results.json is rewritten by every build, so it can only ever describe
// the current commit. The calendar is built from jukebox.test_runs instead, one
// row per run. Two things have to stay true for it to mean anything: recording
// a run must never be able to fail a build, and a day has to be judged by its
// worst run rather than its last one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRepoFile, loadFnsFrom } from './_load.mjs';

const runner = readRepoFile('scripts/run-tests.mjs');
const route = readRepoFile('src/app/api/sj-admin-tests/route.ts');
const page = readRepoFile('public/test-coverage/index.html');
const migration = readRepoFile('supabase/migrations/20260910143000_jukebox_test_runs.sql');

// ── Recording a run ───────────────────────────────────────────────────────

test('recording a run can never fail the build that produced it', () => {
  const at = runner.indexOf('async function recordRun(');
  assert.ok(at > 0, 'recordRun is gone');
  const body = runner.slice(at, runner.indexOf('\nasync function report()', at));
  assert.match(body, /try \{/, 'the insert is not wrapped');
  assert.match(body, /catch \(err\)/);
  assert.match(body, /console\.warn/, 'a failed insert should warn, not throw');
  // The one throw is inside the try, turning a bad HTTP status into the same
  // warning as a network error. Nothing may escape past the catch.
  const afterCatch = body.slice(body.indexOf('catch (err)'));
  assert.doesNotMatch(afterCatch, /throw|process\.exit/, 'recordRun must not end the process');
  assert.match(body, /if \(!key\)[\s\S]{0,120}return;/, 'no key at all should simply skip');
});

test('a run carries only its failures, not every test name it ever ran', () => {
  // Keeping all 157 names for every run forever is how a history table becomes
  // the biggest thing in the database.
  const at = runner.indexOf('async function recordRun(');
  const body = runner.slice(at, runner.indexOf('\nasync function report()', at));
  assert.match(body, /t\.status === 'fail'/);
  assert.match(body, /failures: failed/);
  assert.doesNotMatch(body, /suites: result\.suites\b/, 'the whole suite tree must not be stored');
});

test('the insert is service-role only and names the jukebox schema', () => {
  const at = runner.indexOf('async function recordRun(');
  const body = runner.slice(at, runner.indexOf('\nasync function report()', at));
  assert.match(body, /'Content-Profile': 'jukebox'/, 'without this it writes to public');
  assert.match(body, /rest\/v1\/test_runs/);
  assert.match(body, /AbortSignal\.timeout/, 'a hung insert would hang the build');
});

test('a build labels its run as a deploy, and a laptop labels it local', () => {
  const at = runner.indexOf('async function recordRun(');
  const body = runner.slice(at, runner.indexOf('\nasync function report()', at));
  assert.match(body, /source: process\.env\.VERCEL_GIT_COMMIT_SHA \? 'build' : 'local'/);
});

// ── The table ─────────────────────────────────────────────────────────────

test('the history table is closed to anon and authenticated, policy AND grant', () => {
  // A policy written without a grant verifies nothing: PostgREST simply reports
  // the table as missing from its schema cache.
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on jukebox\.test_runs from anon, authenticated/i);
  assert.match(migration, /grant [^;]*to service_role/i);
  assert.match(migration, /create policy .* on jukebox\.test_runs/i);
});

test('the history is read through the admin route, never from the browser', () => {
  assert.match(route, /isSjAdmin/);
  assert.match(route, /from\("test_runs"\)/);
  assert.match(route, /schema\(JUKEBOX_SCHEMA\)/);
  assert.doesNotMatch(page, /rest\/v1\/test_runs/, 'the page must not read the table directly');
  assert.doesNotMatch(page, /service_role|SERVICE_ROLE/, 'no service key ever reaches the browser');
});

test('a history that will not load still lets the current run through', () => {
  assert.match(route, /historyAvailable/);
  const at = route.indexOf('async function history()');
  const body = route.slice(at, route.indexOf('export async function GET', at));
  assert.match(body, /catch/);
  assert.match(body, /return null;/, 'a failed history should be null, not a thrown request');
});

// ── The calendar ──────────────────────────────────────────────────────────

const { dayKey } = loadFnsFrom(page, ['dayKey']);

test('a run is filed under the local day, not the UTC one', () => {
  // A deploy at 9pm Central is a Tuesday to the person reading this, and a
  // calendar that files it on Wednesday is wrong however defensible the maths.
  const local = new Date(2026, 8, 10, 21, 30);
  assert.equal(dayKey(local), '2026-09-10');
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 1)), '2026-01-01');
  assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('the day key pads months and days so it sorts as text', () => {
  assert.equal(dayKey(new Date(2026, 2, 5, 12)), '2026-03-05');
  assert.match(dayKey(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

test('a day is judged by its worst run, not its last', () => {
  // A green afternoon does not undo a red morning. The question a calendar
  // answers is "was anything broken that day".
  const at = page.indexOf('function paintCalendar()');
  const body = page.slice(at, page.indexOf('function monthSummary(', at));
  assert.match(body, /runs\.some\(r => r\.failed > 0\)/);
});

test('a day with no runs is not a button, so there is nothing to click into', () => {
  const at = page.indexOf('function paintCalendar()');
  const body = page.slice(at, page.indexOf('function monthSummary(', at));
  assert.match(body, /runs\.length \? '<button/);
  assert.match(body, /cls\.push\('has'/);
});

test('the month arrows stop at the ends of the recorded history', () => {
  const at = page.indexOf('function paintCalendar()');
  const body = page.slice(at, page.indexOf('function monthSummary(', at));
  assert.match(body, /const canPrev =/);
  assert.match(body, /const canNext =/);
  assert.match(body, /canPrev \? '' : ' disabled'/);
  assert.match(body, /canNext \? '' : ' disabled'/);
});

test('an empty history says so rather than drawing a blank month', () => {
  const at = page.indexOf('function paintCalendar()');
  const body = page.slice(at, page.indexOf('function monthSummary(', at));
  assert.match(body, /No runs recorded yet/);
  assert.match(body, /could not be read from the database/);
});

// ── The logo ──────────────────────────────────────────────────────────────

test('the page wears the site logo, and the file it points at exists', () => {
  assert.match(page, /<img src="\/suffering-jukebox-text-logo\.png" alt="Suffering Jukebox">/);
  assert.ok(readRepoFile('public/suffering-jukebox-text-logo.png').length > 0);
  assert.match(page, /class="brand-tag">Admin</, 'the logo alone would not say this is the restricted area');
});
