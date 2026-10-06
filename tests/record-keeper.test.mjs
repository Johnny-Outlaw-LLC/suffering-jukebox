// @suite Record Keeper production
// @area Platform
// @covers src/lib/surface.ts src/proxy.ts public/index.html
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { loadTs, loadHtmlFnsInScope, readRepoFile } from './_load.mjs';
const surface = loadTs('src/lib/surface.ts');
const head = loadTs('src/lib/surface-head.ts', { 'lib/surface': surface });
const RK = surface.SURFACES.rk;
test('Record Keeper resolves its own hosts and shares catalog features', () => {
  for (const host of ['recordkeeper.stream', 'www.recordkeeper.stream']) assert.equal(surface.surfaceFromHost(host).id, 'rk');
  assert.equal(surface.surfaceFromHost('recordkeeper.stream.attacker.com'), null);
  assert.equal(RK.features.homeTab, true);
  assert.equal(RK.features.artistUpload, true);
  assert.equal(RK.features.playlistsFirst, true);
  assert.equal(RK.features.liveStations, true);
  assert.equal(RK.features.spotifyPlayback, false);
  assert.equal(surface.SURFACES.sj.features.spotifyPlayback, true);
  assert.equal(surface.SURFACES.lp.features.spotifyPlayback, true);
});
test('Record Keeper metadata and assets stay on its production domain', () => {
  const html = head.applySurfaceHead(readRepoFile('public/index.html'), RK, {
    title: RK.title, description: RK.description, jsonLd: RK.homeJsonLd,
  });
  const h = html.slice(0, html.indexOf('</head>'));
  assert.match(h, /canonical" href="https:\/\/recordkeeper.stream\//);
  assert.match(h, /setAttribute\("data-surface","rk"\)/);
  for (const path of [RK.textLogo, '/brand/rk/favicon.png', '/brand/rk/favicon-32.png', RK.ogImage.slice(RK.url.length)]) {
    assert.ok(existsSync(new URL('../public' + path, import.meta.url)), path);
  }
  assert.equal((h.match(/rel="canonical"/g) || []).length, 1);
});
test('Record Keeper has complete on-domain audience and policy pages', () => {
  for (const page of ['for-artists','for-listeners','about','help','privacy','terms','dmca']) {
    const html = readRepoFile(`public/${page}/rk/index.html`);
    assert.ok(html.includes('Record Keeper'), page);
    assert.ok(!html.includes('outlawapps.online/record-keeper'), page);
    assert.ok(!html.includes('brand preview'), page);
    assert.ok(!html.includes('https://listeningparty.stream'), page);
  }
});
test('Record Keeper explores artists, songs and playlists from its phone tab', () => {
  const { lptbExploreSwitcherHTML } = loadHtmlFnsInScope(['lptbExploreSwitcherHTML'], {
    SJ_BRAND: surface.publicSurface(RK), landingTab: 'explore', landingTabAllowed: () => true,
  });
  const html = lptbExploreSwitcherHTML();
  assert.ok(html.includes('Artists'));
  assert.ok(html.includes('Songs'));
  assert.ok(html.includes('Playlists'));
});
