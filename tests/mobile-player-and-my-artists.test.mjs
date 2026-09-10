// @suite Phone player and My Artists
// @area Playback
// @covers the phone player sheet and Add to My Artists in public/index.html
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('mobile player exposes compact and full-screen controls without drag handles', () => {
  const start = html.indexOf('/* A phone player has two deliberate states');
  const mobileCss = html.slice(start, start + 7000);
  assert.ok(start > 0, 'could not locate mobile player CSS');
  assert.match(mobileCss, /\.ytp-mf-resize,[\s\S]*display: none !important/);
  assert.match(mobileCss, /\.ytp-mf-top \{ display: none; \}/);
  assert.match(mobileCss, /#ytp-mf-minimize \{ display: none !important; \}/);
  assert.match(mobileCss, /"window window"/);
  assert.match(html, /class="ytp-mf-mobile-window"[\s\S]*ytpToggleMinimize\(\)[\s\S]*closeYTPlayer\(\)/);
  assert.match(html, /class="ytp-md-window-controls"[\s\S]*ytpToggleFullscreen\(\)[\s\S]*ytpCloseToMini\(\)/);
});

test('artist menu can add a public, non-owned artist to My Artists', () => {
  const from = html.indexOf('function lamRender(row)');
  const to = html.indexOf('// Every song this artist has', from);
  assert.ok(from > 0 && to > from, 'could not locate artist menu');
  const block = html.slice(from, to);
  assert.match(block, /canAddToMyArtists/);
  assert.match(block, /Add to My Artists/);
  assert.match(block, /row\.visibility === 'public'/);
  assert.match(block, /sjmSendToMyJukebox\('artist', artistId, row\.name/);
  assert.doesNotMatch(block, /saveArtistFeedback\(artistId/);
});
