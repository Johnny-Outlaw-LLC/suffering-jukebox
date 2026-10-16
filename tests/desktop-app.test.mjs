// @suite Record Keeper desktop app
// @area Platform
// @covers native/recordkeeper/desktop/lib.js native/recordkeeper/desktop/main.js
// @covers public/index.html sjd*, sjNativeSignIn
// @covers src/lib/surface.ts desktopApp
// @covers src/lib/desktop-app.ts src/app/api/desktop-download/route.ts
//
// The desktop app is a window around the live site. What can drift is the
// seam: the sign-in scheme it registers against the one the page redirects to,
// the origins it trusts against the brand's, the installer version against the
// download link, and the page code that must stay inert in a plain browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { loadTs, loadHtmlFnsInScope, readRepoFile } from './_load.mjs';

const require = createRequire(import.meta.url);
const L = require('../native/recordkeeper/desktop/lib.js');
const surface = loadTs('src/lib/surface.ts');
const desktop = loadTs('src/lib/desktop-app.ts');
const RK = surface.SURFACES.rk;

test('only Record Keeper offers the desktop app', () => {
  assert.equal(RK.features.desktopApp, true);
  assert.equal(surface.SURFACES.sj.features.desktopApp, false);
  assert.equal(surface.SURFACES.lp.features.desktopApp, false);
  assert.equal(surface.publicSurface(RK).features.desktopApp, true);
});

test('the shell registers the same sign-in scheme and origins as the brand', () => {
  assert.equal(L.AUTH_SCHEME, RK.authScheme);
  assert.deepEqual([...L.APP_ORIGINS].sort(), [...RK.origins].sort());
  assert.ok(L.SITE_URL.startsWith(RK.url));
  const pkg = JSON.parse(readRepoFile('native/recordkeeper/desktop/package.json'));
  assert.deepEqual(pkg.build.protocols[0].schemes, [RK.authScheme]);
});

test('the download link points at the version the shell is built as', () => {
  const pkg = JSON.parse(readRepoFile('native/recordkeeper/desktop/package.json'));
  assert.equal(desktop.DESKTOP_APP.version, pkg.version);
  const url = desktop.desktopDownloadUrl('windows');
  assert.equal(url, `https://github.com/Johnny-Outlaw-LLC/suffering-jukebox/releases/download/rk-desktop-v${pkg.version}/Record-Keeper-Setup-${pkg.version}.exe`);
  // electron-builder names the file from artifactName; keep the two in step.
  assert.equal(pkg.build.win.artifactName.replace('${version}', pkg.version).replace('${ext}', 'exe'), desktop.DESKTOP_APP.files.windows);
  assert.equal(desktop.desktopDownloadUrl('mac'), null);
  assert.equal(desktop.desktopDownloadUrl('linux'), null);
});

test('only our own pages load in the app window', () => {
  assert.ok(L.isAppUrl('https://recordkeeper.stream/p/abc'));
  assert.ok(L.isAppUrl('https://www.recordkeeper.stream/'));
  assert.ok(!L.isAppUrl('https://recordkeeper.stream.attacker.com/'));
  assert.ok(!L.isAppUrl('https://accounts.google.com/o/oauth2'));
  assert.ok(L.isAppUrl('http://localhost:3021/', ['http://localhost:3021']));
  assert.ok(!L.isExternalWebUrl('file:///C:/Windows/system32/calc.exe'));
  assert.ok(!L.isExternalWebUrl('javascript:alert(1)'));
});

test('sign-in only opens the auth hop or the Supabase authorize URL', () => {
  const authorize = 'https://ntyvtpimesfoesuykuyi.supabase.co/auth/v1/authorize?provider=google';
  assert.ok(L.isAllowedSignInUrl(authorize));
  assert.ok(L.isAllowedSignInUrl('https://recordkeeper.stream/api/sj-auth-start?to=' + encodeURIComponent(authorize)));
  assert.ok(!L.isAllowedSignInUrl('https://recordkeeper.stream/api/sj-account'));
  assert.ok(!L.isAllowedSignInUrl('https://evil.example/auth/v1/authorize'));
  assert.ok(!L.isAllowedSignInUrl('http://ntyvtpimesfoesuykuyi.supabase.co/auth/v1/authorize'));
});

test('the sign-in callback is found in a second launch\'s arguments', () => {
  const cb = 'com.johnnyoutlaw.recordkeeper://auth?code=abc';
  assert.equal(L.findAuthCallback(['C:\\Program Files\\Record Keeper\\Record Keeper.exe', '--', cb]), cb);
  assert.equal(L.findAuthCallback(['app.exe', 'https://recordkeeper.stream/']), null);
  assert.equal(L.findAuthCallback(null), null);
});

test('settings keep only what the shell knows, and the page may change only its four switches', () => {
  const s = L.normalizeSettings({ tray: false, alwaysOnTop: 'yes', bounds: { x: 1, y: 2, width: 50, height: 50 }, evil: 1 });
  assert.equal(s.tray, false);
  assert.equal(s.alwaysOnTop, false);
  assert.equal(s.bounds, null);
  assert.equal('evil' in s, false);
  const next = L.applyPatch(L.DEFAULT_SETTINGS, { alwaysOnTop: true, minimizeToMini: true, bounds: { x: 0 }, trayNoticeShown: true });
  assert.equal(next.alwaysOnTop, true);
  assert.equal(next.trayNoticeShown, false);
  assert.deepEqual(L.publicSettings(next), { tray: true, closeToTray: true, alwaysOnTop: true, minimizeToMini: true });
  assert.equal(L.DEFAULT_SETTINGS.minimizeToMini, false);
  assert.equal(L.normalizeSettings({ minimizeToMini: true }).minimizeToMini, true);
});

test('player state from the page is trimmed before it reaches the Mini Player', () => {
  assert.deepEqual(L.sanitizeState(null), { has: false });
  const st = L.sanitizeState({ has: true, title: 'Random Rules', artist: 'Silver Jews', art: 'javascript:alert(1)', playing: 1, pos: -5, dur: 240 });
  assert.equal(st.art, '');
  assert.equal(st.playing, true);
  assert.equal(st.pos, 0);
  assert.equal(st.dur, 240);
  assert.equal(st.next, null);
  const withNext = L.sanitizeState({ has: true, title: 'a', next: { title: 'Crow', artist: 'Shellac', evil: '<b>' }, canSkipNext: 1 });
  assert.deepEqual(withNext.next, { title: 'Crow', artist: 'Shellac' });
  assert.equal(withNext.canSkipNext, true);
  assert.equal(L.sanitizeState({ has: true, next: { title: 42 } }).next, null);
  assert.match(L.trayTooltip({ title: 'x'.repeat(300), playing: true }), /…$/);
  assert.ok(L.trayTooltip({ title: 'x'.repeat(300), playing: true }).length <= 127);
});

test('a remembered Mini Player position stays on screen', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(L.clampToArea({ x: 5000, y: -40 }, L.MINI_SIZE, area), { x: 1920 - L.MINI_SIZE.width, y: 0 });
  const d = L.defaultMiniPos(area);
  assert.ok(d.x + L.MINI_SIZE.width <= area.width && d.y + L.MINI_SIZE.height <= area.height);
});

test('in a plain browser the desktop bridge is inert', () => {
  const scope = { window: {}, SJ_BRAND: surface.publicSurface(RK) };
  const { sjIsDesktop, sjdAuthPlugin } = loadHtmlFnsInScope(['sjIsDesktop', 'sjdAuthPlugin'], scope);
  assert.equal(sjIsDesktop(), false);
  assert.equal(sjdAuthPlugin(), null);
});

test('inside the app, sign-in goes through the bridge', async () => {
  const calls = [];
  const scope = { window: { sjDesktop: { pushState() {}, signIn: async (o) => { calls.push(o); return { url: 'cb' }; } } } };
  const { sjIsDesktop, sjdAuthPlugin } = loadHtmlFnsInScope(['sjIsDesktop', 'sjdAuthPlugin'], scope);
  assert.equal(sjIsDesktop(), true);
  const res = await sjdAuthPlugin().signIn({ url: 'https://x', callbackScheme: 'y' });
  assert.deepEqual(res, { url: 'cb' });
  assert.equal(calls.length, 1);
  const html = readRepoFile('public/index.html');
  assert.match(html, /window\.Capacitor\?\.Plugins\?\.SJAuth \|\| sjdAuthPlugin\(\)/);
  assert.match(html, /if \(sjIsNative\(\) \|\| sjIsDesktop\(\)\) return sjNativeSignIn\(\);/);
});

test('the desktop app is never mistaken for the phone shell', () => {
  // sjIsNative() switches on native audio and CarPlay. The desktop bridge must
  // not define the Capacitor globals that it checks.
  const preload = readRepoFile('native/recordkeeper/desktop/preload.js');
  assert.ok(!/Capacitor/.test(preload.replace(/\/\/.*$/gm, '')));
  assert.match(preload, /exposeInMainWorld\('sjDesktop'/);
});

test('player transport commands reach the right player functions', () => {
  const log = [];
  const scope = {
    ytPlayerEl: {},
    ytTogglePlayPause: () => log.push('toggle'),
    ytNextTrack: () => log.push('next'),
    ytBackTrack: () => log.push('prev'),
    ytpMfSeekCommit: (el) => log.push('seek:' + el.value),
    ytpReact: async (r, a, e) => { log.push('react:' + r + ':' + a + ':' + e); },
    ytSkipUpNext: () => log.push('skipNext'),
    sjdPush: () => {},
    setTimeout: () => 0,
    console,
  };
  const { sjdCommand } = loadHtmlFnsInScope(['sjdCommand'], scope);
  sjdCommand('toggle'); sjdCommand('next'); sjdCommand('prev'); sjdCommand('seek', 42.5);
  sjdCommand('seek', -1); sjdCommand('heart'); sjdCommand('skipNext'); sjdCommand('rm -rf');
  assert.deepEqual(log, ['toggle', 'next', 'prev', 'seek:42.5', 'react:heart:null:null', 'skipNext']);
  const main = readRepoFile('native/recordkeeper/desktop/main.js');
  assert.match(main, /\['toggle', 'next', 'prev', 'seek', 'heart', 'skipNext'\]/);
});

test('Settings has a Desktop App section the page can show', () => {
  const html = readRepoFile('public/index.html');
  assert.match(html, /const SET_SECTIONS = \[[^\]]*'desktop'\]/);
  assert.match(html, /data-set-pane="desktop"/);
  assert.match(html, /data-set-nav="desktop" data-sj-feature="desktopApp"/);
  assert.match(html, /desktopApp: false \}\r?\n\}, \(window\.__SURFACE__/);
});

test('Home offers the Windows download only where it is useful', () => {
  const html = (scope) => loadHtmlFnsInScope(['lphDesktopHTML'], {
    lphEsc: (s) => String(s), sjIsDesktop: () => false, navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    window: {}, ...scope,
  }).lphDesktopHTML();
  const rk = surface.publicSurface(RK);
  assert.match(html({ SJ_BRAND: rk }), /href="\/api\/desktop-download\?platform=windows"/);
  assert.equal(html({ SJ_BRAND: surface.publicSurface(surface.SURFACES.lp) }), '');
  assert.equal(html({ SJ_BRAND: rk, sjIsDesktop: () => true }), '');
  assert.equal(html({ SJ_BRAND: rk, navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } }), '');
});
