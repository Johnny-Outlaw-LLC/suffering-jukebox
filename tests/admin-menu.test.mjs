// @suite Admin menu and the Test Coverage page
// @area Admin
// @covers the account menu in public/index.html, public/test-coverage/index.html,
//         src/app/test-coverage/route.ts, src/app/api/sj-admin-tests/route.ts
//
// An admin entry is three things that have to agree: a button carrying
// admin-only, an action in userMenuAction that re-checks sjIsAdmin before doing
// anything, and a route at the other end. A button with no handler is dead, and
// a handler that trusts the hidden button is not a check at all - the class only
// hides it, and anybody can unhide it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml, htmlSlice, readRepoFile, loadTs } from './_load.mjs';

const menu = htmlSlice('id="user-menu-playlists"', '</div>');
const handler = htmlSlice('async function userMenuAction(action)', '\n// ');

/** Every admin-only entry in the account menu, as [id, action]. */
const adminItems = [...menu.matchAll(
  /class="user-menu-item admin-only"\s+id="([\w-]+)"[^>]*onclick="userMenuAction\('([\w-]+)'\)"/g,
)].map((m) => [m[1], m[2]]);

test('the account menu has admin entries and Test Coverage is one of them', () => {
  assert.ok(adminItems.length >= 5, 'found only ' + adminItems.length + ' admin entries');
  assert.ok(
    adminItems.some(([id, action]) => id === 'user-menu-tests' && action === 'tests'),
    'Test Coverage is missing from the account menu',
  );
  assert.match(menu, />Test Coverage</);
});

test('every admin entry has a handler that re-checks who is asking', () => {
  // The admin-only class only HIDES the button. The check that matters is the
  // one inside the action.
  for (const [, action] of adminItems) {
    const at = handler.indexOf(`if (action === '${action}')`);
    assert.ok(at > 0, 'userMenuAction has no branch for ' + action);
    const branch = handler.slice(at, at + 400);
    assert.match(branch, /if \(!sjIsAdmin\) return;/, action + ' does not re-check sjIsAdmin');
  }
});

test('Test Coverage opens the page rather than a modal', () => {
  const at = handler.indexOf("if (action === 'tests')");
  const branch = handler.slice(at, at + 400);
  assert.match(branch, /window\.open\('\/test-coverage'/);
  assert.match(branch, /noopener/, 'a new tab opened without noopener hands it a reference back');
});

test('the page the menu opens actually exists, and is served by a route', () => {
  const page = readRepoFile('public/test-coverage/index.html');
  assert.match(page, /<title>Test Coverage \| Suffering Jukebox Admin<\/title>/);
  assert.match(readRepoFile('src/app/test-coverage/route.ts'), /public",\s*"test-coverage"/);
});

test('the page is gated on the server check, not on the menu having hidden itself', () => {
  const page = readRepoFile('public/test-coverage/index.html');
  assert.match(page, /\/api\/sj-admin-check/);
  assert.match(page, /Administrator access required/);
});

test('the page is never indexed', () => {
  assert.match(readRepoFile('public/test-coverage/index.html'), /name="robots" content="noindex,nofollow"/);
  assert.match(readRepoFile('src/app/test-coverage/route.ts'), /X-Robots-Tag/);
});

test('a host cannot claim test-coverage as their room address', () => {
  // /[slug] is a rewrite in the middleware, so an unreserved word here would
  // shadow the admin page for everybody.
  const jb = loadTs('src/lib/jukebox.ts');
  assert.ok(jb.RESERVED_SLUGS.has('test-coverage'));
  assert.equal(jb.normalizeVanitySlug('test-coverage').ok, false);
});

test('the report is not published to the open web', () => {
  // The page says Restricted. A file under public/ would be readable by anyone
  // who guessed the path, and it names every check and every gap in the app.
  const page = readRepoFile('public/test-coverage/index.html');
  assert.match(page, /fetch\('\/api\/sj-admin-tests'/);
  assert.doesNotMatch(page, /fetch\('\/test-results\.json/);
  assert.match(readRepoFile('src/app/api/sj-admin-tests/route.ts'), /isSjAdmin/);
  assert.throws(
    () => readRepoFile('public/test-results.json'),
    /ENOENT/,
    'the report is sitting in public/, where anyone can read it',
  );
});

test('the results the page reads are committed, and describe this repository', () => {
  const report = JSON.parse(readRepoFile('test-results.json'));
  assert.ok(report.totals.tests > 0, 'the committed report has no tests in it');
  assert.ok(Array.isArray(report.suites) && report.suites.length > 0);
  assert.ok(report.generatedAt, 'a report with no timestamp cannot be judged stale');
  for (const suite of report.suites) {
    assert.ok(suite.area, suite.file + ' has no @area, so it lands in Unsorted');
    assert.ok(suite.suite, suite.file + ' has no @suite');
  }
});

test('the dashboard is the only place the menu is defined', () => {
  // Two copies of the account menu is how one of them goes stale.
  assert.equal(
    (dashboardHtml.match(/id="user-menu-tests"/g) || []).length,
    1,
    'the Test Coverage entry appears more than once',
  );
});
