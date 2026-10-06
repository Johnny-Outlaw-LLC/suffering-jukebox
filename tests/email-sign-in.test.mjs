// Signing in with Apple, Google, or an email and password, and the rule that
// nothing here can change a password - the shared smoke-test account
// (testing@shutterfield.com, credited as Johnny D) signs in with Shutterfield's
// password, and a site that reset it would break Shutterfield's tests too.
//
// @suite email-sign-in
// @area Accounts
// @covers handleAuthClick, sjAppleSignIn, sjGoogleSignIn, sjEmailSignIn, sjSignInErr, jukebox.ensure_test_account
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardHtml, loadHtmlFnsInScope, loadTs } from './_load.mjs';
import { TEST_ACCOUNT } from '../scripts/test-account.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Just enough of a page for the sign-in functions: elements by id. */
function fakePage() {
  const els = {};
  const document = {
    getElementById(id) {
      if (!els[id]) {
        const classes = new Set();
        els[id] = {
          id, value: '', hidden: true, textContent: '', disabled: false,
          classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
          focus() {},
        };
      }
      return els[id];
    },
  };
  return { els, document };
}

function signInScope(authResult) {
  const page = fakePage();
  const calls = { password: [], reloads: 0, repaints: 0, stored: {} };
  const scope = {
    googleUser: null,
    sjIsNative: () => false,
    sjNativeRepaint: () => { calls.repaints++; },
    document: page.document,
    setTimeout: () => {},
    localStorage: { setItem: (k, v) => { calls.stored[k] = v; } },
    window: { location: { pathname: '/silver-jews', search: '', reload: () => { calls.reloads++; } } },
    sbAuth: {
      auth: {
        signInWithPassword: async (creds) => { calls.password.push(creds); return authResult; },
      },
    },
  };
  return { page, calls, scope };
}

test('the header Sign In opens the sign-in panel rather than going straight to Google', () => {
  const { page, scope } = signInScope({ error: null });
  let google = 0;
  scope.sjGoogleSignIn = () => { google++; };
  const { handleAuthClick } = loadHtmlFnsInScope(['handleAuthClick', 'sjSignInErr'], scope);
  handleAuthClick();
  assert.ok(page.els.signInOverlay.classList.contains('open'), 'the panel did not open');
  assert.equal(google, 0);
  assert.match(dashboardHtml, /id="auth-btn" onclick="handleAuthClick\(\)"/);
});

test('the panel offers native Apple, Google, and an email/password form a password manager recognises', () => {
  const at = dashboardHtml.indexOf('id="signInOverlay"');
  assert.ok(at >= 0, 'no sign-in panel in the page');
  const panel = dashboardHtml.slice(at, dashboardHtml.indexOf('</form>', at));
  assert.match(panel, /id="signin-apple"[^>]*onclick="sjAppleSignIn\(\)"[^>]*hidden/);
  assert.match(panel, /onclick="sjGoogleSignIn\(\)"/);
  assert.match(panel, /id="signin-email"[^>]*type="email"[^>]*autocomplete="username"/);
  assert.match(panel, /id="signin-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(panel, /onsubmit="event\.preventDefault\(\);sjEmailSignIn\(\)"/);
});

test('the Listening Party native shell has a distinct secure origin from its API', () => {
  const config = JSON.parse(readFileSync(join(root, 'native', 'capacitor.config.json'), 'utf8'));
  assert.equal(config.server.iosScheme, 'https');
  assert.equal(config.server.hostname, 'app.listeningparty.stream');
  const surfaces = loadTs('src/lib/surface.ts');
  assert.equal(surfaces.SURFACES.lp.url, 'https://listeningparty.stream');
  assert.equal(surfaces.SURFACES.rk.url, 'https://recordkeeper.stream');
  assert.match(readFileSync(join(root, 'native', 'scripts', 'build-web.mjs'), 'utf8'), /surfaces\.SURFACES\[id\]/);
});

test('native Apple sign-in exchanges a nonce-bound identity token and preserves the first name', async () => {
  const { page, calls, scope } = signInScope({ error: null });
  const tokens = [];
  const profiles = [];
  Object.assign(scope, {
    sjIsNative: () => true,
    window: {
      location: { pathname: '/silver-jews', search: '', reload: () => { calls.reloads++; } },
      Capacitor: { Plugins: { SJAuth: {
        signInWithApple: async () => ({ identityToken: 'apple.jwt', nonce: 'raw-nonce', fullName: 'Johnny D' }),
      } } },
    },
    sbAuth: { auth: {
      signInWithIdToken: async (payload) => { tokens.push(payload); return { error: null }; },
      updateUser: async (payload) => { profiles.push(payload); return { error: null }; },
    } },
  });
  const { sjAppleSignIn } = loadHtmlFnsInScope(['sjAppleSignIn', 'sjFinishSignIn', 'closeSignIn', 'sjSignInErr'], scope);
  await sjAppleSignIn();
  assert.deepEqual(tokens, [{ provider: 'apple', token: 'apple.jwt', nonce: 'raw-nonce' }]);
  assert.deepEqual(profiles, [{ data: { full_name: 'Johnny D' } }]);
  assert.equal(calls.reloads, 0);
  assert.equal(calls.repaints, 1);
  assert.equal(page.els.signInOverlay.classList.contains('open'), false);
  assert.equal(page.els['signin-err'].hidden, true);
});

test('Google is still one tap from the panel', async () => {
  const oauth = [];
  const { scope } = signInScope({ error: null });
  Object.assign(scope, {
    sjIsNative: () => false,
    sjAuthRedirectUrl: () => 'https://www.sufferingjukebox.stream',
    sbAuth: { auth: { signInWithOAuth: async (o) => { oauth.push(o); } } },
  });
  const { sjGoogleSignIn } = loadHtmlFnsInScope(['sjGoogleSignIn'], scope);
  await sjGoogleSignIn();
  assert.equal(oauth.length, 1);
  assert.equal(oauth[0].provider, 'google');
});

test('an email and password sign in, clear the password box, and reload like Google does', async () => {
  const { page, calls, scope } = signInScope({ error: null });
  const { sjEmailSignIn } = loadHtmlFnsInScope(['sjEmailSignIn', 'sjFinishSignIn', 'sjSignInErr', 'closeSignIn'], scope);
  page.document.getElementById('signin-email').value = '  Testing@Shutterfield.com ';
  page.document.getElementById('signin-password').value = 'not-the-real-one';
  await sjEmailSignIn();
  assert.deepEqual(calls.password, [{ email: TEST_ACCOUNT.email, password: 'not-the-real-one' }]);
  assert.equal(calls.reloads, 1);
  assert.equal(page.els['signin-password'].value, '', 'the password was left in the box');
  assert.equal(calls.stored.auth_return_path, '/silver-jews');
});

test('a wrong password says so in plain words and does not reload', async () => {
  const { page, calls, scope } = signInScope({ error: { message: 'Invalid login credentials' } });
  const { sjEmailSignIn } = loadHtmlFnsInScope(['sjEmailSignIn', 'sjFinishSignIn', 'sjSignInErr', 'closeSignIn'], scope);
  page.document.getElementById('signin-email').value = TEST_ACCOUNT.email;
  page.document.getElementById('signin-password').value = 'wrong';
  await sjEmailSignIn();
  assert.equal(calls.reloads, 0);
  assert.equal(page.els['signin-err'].hidden, false);
  assert.equal(page.els['signin-err'].textContent, 'That email and password do not match.');
  assert.equal(page.els['signin-submit'].disabled, false, 'the button stayed disabled after a failure');
});

test('an empty form asks for both fields and never calls Supabase', async () => {
  const { page, calls, scope } = signInScope({ error: null });
  const { sjEmailSignIn } = loadHtmlFnsInScope(['sjEmailSignIn', 'sjFinishSignIn', 'sjSignInErr', 'closeSignIn'], scope);
  page.document.getElementById('signin-email').value = TEST_ACCOUNT.email;
  await sjEmailSignIn();
  assert.equal(calls.password.length, 0);
  assert.equal(page.els['signin-err'].textContent, 'Enter your email and password.');
});

/** Every text source file under a directory. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|sql|html)$/.test(name)) out.push(full);
  }
  return out;
}

test('nothing in the app or its migrations can change a password', () => {
  const offenders = [];
  for (const file of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'public')), ...sourceFiles(join(root, 'supabase'))]) {
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(root.length).replace(/\\/g, '/');
    if (/\.updateUser(ById)?\s*\([^)]*\bpassword\b/.test(text)) offenders.push(`${rel}: updateUser with a password`);
    if (/encrypted_password/.test(text)) offenders.push(`${rel}: touches auth password hashes`);
    if (/resetPasswordForEmail|generateLink\s*\(\s*\{\s*type:\s*['"]recovery/.test(text)) offenders.push(`${rel}: starts a password reset`);
  }
  assert.deepEqual(offenders, []);
});

test('the test account migration names it Johnny D and never writes to auth', () => {
  const dir = join(root, 'supabase', 'migrations');
  const file = readdirSync(dir).find((f) => /_test_account\.sql$/.test(f));
  assert.ok(file, 'no test account migration');
  const sql = readFileSync(join(dir, file), 'utf8');
  assert.match(sql, /create or replace function jukebox\.ensure_test_account/i);
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from)\s+auth\./i);
  assert.ok(sql.includes(`'${TEST_ACCOUNT.email}'`), 'the migration does not name the test account');
  assert.ok(sql.includes(`'${TEST_ACCOUNT.publicName}'`), 'the migration does not set Johnny D');
  // A name somebody already chose is kept, rather than reset on every run.
  assert.match(sql, /coalesce\(nullif\(btrim\(jukebox\.app_users\.public_name\), ''\), excluded\.public_name\)/);
  assert.match(sql, /revoke all on function jukebox\.ensure_test_account\(text, text\) from public, anon, authenticated/);
});

test('the second fixed-password ShutterField account is also seeded for Listening Party', () => {
  const dir = join(root, 'supabase', 'migrations');
  const file = readdirSync(dir).find((f) => /_second_test_account\.sql$/.test(f));
  assert.ok(file, 'no second test account migration');
  const sql = readFileSync(join(dir, file), 'utf8');
  assert.match(sql, /ensure_test_account\('testing2@shutterfield\.com',\s*'Johnny D Two'\)/i);
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from)\s+auth\./i);
});


test('native email sign-in dismisses the keyboard and sheet without reloading the web view', async () => {
  const { page, calls, scope } = signInScope({ error: null });
  scope.sjIsNative = () => true;
  let blurred = false;
  page.document.activeElement = { blur: () => { blurred = true; } };
  const { sjEmailSignIn } = loadHtmlFnsInScope(['sjEmailSignIn', 'sjFinishSignIn', 'sjSignInErr', 'closeSignIn'], scope);
  page.document.getElementById('signInOverlay').classList.add('open');
  page.document.getElementById('signin-email').value = TEST_ACCOUNT.email;
  page.document.getElementById('signin-password').value = 'test-password';
  await sjEmailSignIn();
  assert.equal(calls.password.length, 1);
  assert.equal(calls.reloads, 0);
  assert.equal(calls.repaints, 1);
  assert.equal(blurred, true);
  assert.equal(page.els.signInOverlay.classList.contains('open'), false);
  assert.equal(page.els['signin-password'].value, '');
  assert.equal(page.els['signin-submit'].disabled, false);
});

test('native Google sign-in exchanges the callback and closes the sheet without reloading', async () => {
  const { page, calls, scope } = signInScope({ error: null });
  const codes = [];
  Object.assign(scope, {
    sjIsNative: () => true,
    SJ_AUTH_SCHEME: 'com.johnnyoutlaw.recordkeeper',
    sjApiUrl: path => 'https://recordkeeper.stream' + path,
    window: {
      ...scope.window,
      Capacitor: { Plugins: { SJAuth: {
        signIn: async () => ({ url: 'com.johnnyoutlaw.recordkeeper://auth?code=test-code' }),
      } } },
    },
    sbAuth: { auth: {
      signInWithOAuth: async () => ({ data: { url: 'https://auth.example/authorize' }, error: null }),
      exchangeCodeForSession: async code => { codes.push(code); return { error: null }; },
    } },
  });
  page.document.getElementById('signInOverlay').classList.add('open');
  const { sjNativeSignIn } = loadHtmlFnsInScope(['sjNativeSignIn', 'sjFinishSignIn', 'closeSignIn'], scope);
  await sjNativeSignIn();
  assert.deepEqual(codes, ['test-code']);
  assert.equal(calls.reloads, 0);
  assert.equal(calls.repaints, 1);
  assert.equal(page.els.signInOverlay.classList.contains('open'), false);
});
