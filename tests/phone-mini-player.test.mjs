// @suite Phone mini player
// @area Listening Party
// @covers public/index.html lptb*, ytpDockMobFloor, .dock-mini
// @covers src/lib/surface.ts phoneMiniPlayer
//
// On a phone, Listening Party navigates by a bottom tab bar and rests its
// player on top of it as one slim bar. Suffering Jukebox keeps its quarter
// screen dock and its top tab strip. Both run the same dock code, so what is
// pinned here is that the brand flag is the only thing that tells them apart.
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

test('only Listening Party has the phone mini player, and the browser is told', () => {
  assert.equal(LP.features.phoneMiniPlayer, true);
  assert.equal(SJ.features.phoneMiniPlayer, false);
  assert.equal(surface.publicSurface(LP).features.phoneMiniPlayer, true);
});

test('the resting phone dock is a slim bar for LP and a quarter screen for SJ', () => {
  assert.equal(floorFor(LP).ytpDockMobFloor(812), 64);
  assert.equal(floorFor(SJ).ytpDockMobFloor(812), 203);
  // A short phone still gets the absolute floor, not a sliver.
  assert.equal(floorFor(SJ).ytpDockMobFloor(400), 132);
  // Off a phone the mini bar never applies, whatever the brand.
  assert.equal(floorFor(LP, { mob: false }).ytpDockMobMini(), false);
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
