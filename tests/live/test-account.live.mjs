// Live checks that sign the shared smoke-test account in and use it.
//
// Deliberately NOT a tests/*.test.mjs file: `npm test` runs offline and on every
// Vercel build, and this signs in over the network. Run it with
//
//     npm run test:live
//     SJ_BASE_URL=http://localhost:3021 npm run test:live   # browser check against a dev server
//
// The account is testing@shutterfield.com, credited here as Johnny D. Its
// password comes from SJ_TEST_PASSWORD or from SHUTTERFIELD_TEST_PASSWORD on the
// shutterfield Vercel project (scripts/test-account.mjs). It is never printed,
// and nothing here changes it. Anything a test creates it also removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { TEST_ACCOUNT, testAccountPassword } from '../../scripts/test-account.mjs';

const SUPABASE_URL = 'https://ntyvtpimesfoesuykuyi.supabase.co';
const ANON = readFileSync(new URL('../../src/lib/sj-admin-auth.ts', import.meta.url), 'utf8')
  .match(/SJ_SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)[1];
const BASE_URL = (process.env.SJ_BASE_URL || 'https://www.sufferingjukebox.stream').replace(/\/+$/, '');

let passwordPromise = null;
function password() {
  passwordPromise ||= testAccountPassword().then((pw) => {
    assert.ok(pw, 'No password for the test account: set SJ_TEST_PASSWORD, or VERCEL_TOKEN so it can be read from the shutterfield project.');
    return pw;
  });
  return passwordPromise;
}

let sessionPromise = null;
function session() {
  sessionPromise ||= (async () => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ACCOUNT.email, password: await password() }),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, `sign-in refused: ${body.error_description || body.msg || body.error_code || res.status}`);
    return body;
  })();
  return sessionPromise;
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const { access_token: token } = await session();
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Accept-Profile': 'jukebox',
      'Content-Profile': 'jukebox',
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

test('the test account signs in with its email and password', async () => {
  const s = await session();
  assert.equal(s.user?.email, TEST_ACCOUNT.email);
  assert.ok(s.access_token);
});

test('it is credited as Johnny D', async () => {
  const settings = await rest('/rpc/my_settings', { method: 'POST', body: {} });
  assert.equal(settings.displayName, TEST_ACCOUNT.publicName);
});

test('signed in, it can read the catalogue', async () => {
  const rows = await rest('/rpc/landing_stats', { method: 'POST', body: { p_user_email: null } });
  assert.ok(Array.isArray(rows) && rows.length > 0, 'landing_stats came back empty');
});

test('it can make a private playlist, add a song, read it back and remove it', async () => {
  const [track] = await rest('/tracks?select=id&visibility=eq.public&limit=1');
  assert.ok(track?.id, 'no public track to add');
  let playlist = null;
  try {
    [playlist] = await rest('/playlists', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        name: `Live test ${new Date().toISOString()}`,
        is_public: false,
        visibility: 'private',
        user_email: TEST_ACCOUNT.email,
        user_name: TEST_ACCOUNT.publicName,
      },
    });
    assert.ok(playlist?.id, 'the playlist was not created');
    await rest('/playlist_tracks', {
      method: 'POST',
      prefer: 'return=minimal',
      body: [{
        playlist_id: playlist.id, track_id: track.id, position: 1000,
        added_by_email: TEST_ACCOUNT.email, added_by_name: TEST_ACCOUNT.publicName,
      }],
    });
    const rows = await rest(`/playlist_tracks?playlist_id=eq.${playlist.id}&select=track_id`);
    assert.deepEqual(rows.map((r) => r.track_id), [track.id]);
  } finally {
    if (playlist?.id) {
      await rest(`/playlist_tracks?playlist_id=eq.${playlist.id}`, { method: 'DELETE' });
      await rest(`/playlists?id=eq.${playlist.id}`, { method: 'DELETE' });
    }
  }
});

test('the site signs it in through the email form and shows Johnny D', async (t) => {
  let chromium;
  try {
    ({ chromium } = createRequire(new URL('../../capture/package.json', import.meta.url))('playwright'));
  } catch {
    t.skip('Playwright is not installed (cd capture && npm install)');
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    t.skip(`Playwright could not start a browser (npx playwright install chromium): ${String(e.message).split('\n')[0]}`);
    return;
  }
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
    await page.locator('#auth-btn').click();
    await page.locator('#signin-email').fill(TEST_ACCOUNT.email);
    await page.locator('#signin-password').fill(await password());
    await page.locator('#signin-submit').click();
    // Signing in reloads the page; the name comes from my_settings after that.
    await page.waitForFunction(
      (email) => typeof googleUser !== 'undefined' && googleUser && googleUser.email === email
        && typeof sjDisplayName === 'function' && sjDisplayName() === 'Johnny D',
      TEST_ACCOUNT.email,
      { timeout: 45_000 },
    );
    const err = await page.locator('#signin-err').isVisible().catch(() => false);
    assert.equal(err, false, 'the sign-in panel showed an error');
  } finally {
    await browser.close();
  }
});
