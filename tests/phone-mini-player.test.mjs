// @suite Phone mini player
// @area Player
// @covers public/index.html lptb*, ytpDockMobFloor, .dock-mini
// @covers src/lib/surface.ts phoneMiniPlayer
//
// On a phone, both brands navigate by a bottom tab bar and rest the player on
// top of it as one slim bar. They run the same dock and tab bar code; the
// brand decides only the tab labels and where each tab goes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, loadHtmlFnsInScope, readRepoFile } from './_load.mjs';

const surface = loadTs('src/lib/surface.ts');
const SJ = surface.SURFACES.sj;
const LP = surface.SURFACES.lp;
const indexHtml = readRepoFile('public/index.html');

function floorFor(brand, { mob = true } = {}) {
  const scope = {
    SJ_BRAND: surface.publicSurface(brand),
    ytpIsMob: () => mob,
    YTP_DOCK_MOB_ABS_MIN: 132,
    YTP_DOCK_MOB_MIN_FRAC: 0.25,
    YTP_DOCK_MOB_MINI_H: 64,
  };
  return loadHtmlFnsInScope(['ytpDockMobMini', 'ytpDockMobFloor'], scope);
}

test('both brands have the phone mini player, and the browser is told', () => {
  assert.equal(LP.features.phoneMiniPlayer, true);
  assert.equal(SJ.features.phoneMiniPlayer, true);
  assert.equal(surface.publicSurface(LP).features.phoneMiniPlayer, true);
  assert.equal(surface.publicSurface(SJ).features.phoneMiniPlayer, true);
  // The native app ships index.html without the server's brand injection, so
  // the page's own Suffering Jukebox fallback has to agree with surface.ts.
  assert.match(indexHtml, /welcomeHero: false, phoneMiniPlayer: true, spotifyImport/);
});

test('the resting phone dock is a 64px bar for both brands', () => {
  assert.equal(floorFor(LP).ytpDockMobFloor(812), 64);
  assert.equal(floorFor(SJ).ytpDockMobFloor(812), 64);
  assert.equal(floorFor(SJ).ytpDockMobFloor(568), 64);
  // Off a phone the mini bar never applies, whatever the brand.
  assert.equal(floorFor(LP, { mob: false }).ytpDockMobMini(), false);
  assert.equal(floorFor(SJ, { mob: false }).ytpDockMobMini(), false);
  // A brand without the flag still gets the quarter screen sheet.
  const off = { ...surface.publicSurface(SJ), features: { ...SJ.features, phoneMiniPlayer: false } };
  assert.equal(floorFor(off).ytpDockMobFloor(812), 203);
  assert.equal(floorFor(off).ytpDockMobFloor(400), 132);
});

function tabsFor(brand) {
  const { lptbTabs } = loadHtmlFnsInScope(['lptbTabs'], {
    SJ_BRAND: surface.publicSurface(brand),
    LPTB_TABS_BY_BRAND: loadConst('LPTB_TABS_BY_BRAND'),
  });
  return lptbTabs();
}
function loadConst(name) {
  const at = indexHtml.indexOf('const ' + name + ' = ');
  const src = indexHtml.slice(at + ('const ' + name + ' = ').length);
  const body = src.slice(0, src.indexOf('\n};') + 2);
  return Function('"use strict"; return (' + body + ');')();
}

test('tab labels are per brand: SJ leads with artists, LP keeps Home and Create', () => {
  assert.deepStrictEqual(tabsFor(SJ).map(t => t.label), ['Artists', 'Playlists', 'Songs', 'You']);
  assert.deepStrictEqual(tabsFor(SJ).map(t => t.id), ['explore', 'playlists', 'songs', 'you']);
  assert.deepStrictEqual(tabsFor(LP).map(t => t.label), ['Home', 'Explore', 'Create', 'You']);
  // LP's Explore stands for all three explore sheets.
  assert.deepStrictEqual(tabsFor(LP)[1].also, ['explore', 'songs', 'live']);
});

test('a tab tapped on an artist page goes home in place instead of reloading', () => {
  const calls = [];
  const scope = {
    viewMode: 'byyear', isLandingMode: false, landingTab: 'explore',
    artistNavToLanding: tab => { calls.push(tab); return Promise.resolve(); },
    returnToPlaylistExplorer: () => calls.push('wall'),
    setLandingTab: () => calls.push('set'),
    lptbSync: () => {},
    localStorage: { setItem() {} },
    window: { scrollTo() {}, location: { set href(v) { calls.push('reload:' + v); } } },
  };
  const { lptbGo } = loadHtmlFnsInScope(['lptbGo'], scope);
  lptbGo('songs');
  assert.deepStrictEqual(calls, ['songs']);
});

test('both places that size the phone dock read the same floor', () => {
  assert.ok(
    !indexHtml.includes('Math.max(YTP_DOCK_MOB_ABS_MIN, Math.round(vh * YTP_DOCK_MOB_MIN_FRAC)) : rest'),
    'a dock sizing path still computes its own floor',
  );
  assert.equal((indexHtml.match(/const min = mob \? ytpDockMobFloor\(vh\) : rest;/g) || []).length, 2);
  assert.ok(indexHtml.includes("el.classList.toggle('dock-mini', mob && ytpDockMobMini());"));
});

test('the tab bar is gated on the flag and mounted once', () => {
  assert.ok(/function lptbMount\(\) \{\s*if \(!SJ_BRAND\.features\.phoneMiniPlayer \|\| document\.getElementById\('lp-tabbar'\)\) return;/.test(indexHtml));
  assert.ok(indexHtml.includes("document.documentElement.classList.add('has-phone-tabbar');"));
  assert.ok(!indexHtml.includes('lp-has-tabbar'), 'the old brand-specific class name is back');
  assert.ok(/function renderLanding\(\) \{\s*lptbSync\(\);/.test(indexHtml), 'the active tab does not follow renders');
});

test('the tab bar is phone-only and stacks under the full screen player', () => {
  assert.ok(indexHtml.includes('#lp-tabbar { display: none; }'), 'the tab bar must be hidden off a phone');
  const rule = indexHtml.slice(indexHtml.indexOf('  #lp-tabbar { display: grid;'));
  assert.ok(/^[^}]*z-index: 2000;/.test(rule), 'the tab bar must sit under the full screen player (2001)');
  // The mini bar still has a way into everything it hides.
  assert.ok(/dock\.addEventListener\('click'[\s\S]{0,200}ytpEnterFullscreen\(\)/.test(indexHtml));
  assert.ok(indexHtml.includes('if (dy < -30) ytpEnterFullscreen();'), 'swipe up no longer opens the player');
});

test('You signs a visitor in, or opens the account menu', () => {
  const calls = [];
  const scope = {
    googleUser: null,
    handleAuthClick: () => calls.push('auth'),
    toggleUserMenu: () => calls.push('menu'),
    window: { scrollTo() {} },
  };
  const { lptbYou } = loadHtmlFnsInScope(['lptbYou'], scope);
  lptbYou({});
  scope.googleUser = { email: 'a@b.c' };
  lptbYou({});
  assert.deepStrictEqual(calls, ['auth', 'menu']);
});
