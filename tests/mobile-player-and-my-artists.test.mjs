// @suite Phone player and My Artists
// @area Playback
// @covers the phone player sheet and Add to My Artists in public/index.html
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('mobile dock has no resize handle, and the full player is dismissed by pulling it down', () => {
  const start = html.indexOf('/* A phone player has two deliberate states');
  const mobileCss = html.slice(start, start + 7000);
  assert.ok(start > 0, 'could not locate mobile player CSS');
  assert.match(mobileCss, /\.ytp-mf-resize \{ display: none !important; \}/);
  assert.match(mobileCss, /\.ytp-mf-top \{ display: none; \}/);
  assert.match(mobileCss, /#ytp-mf-minimize \{ display: none !important; \}/);
  assert.match(mobileCss, /"window window"/);
  assert.match(html, /class="ytp-mf-mobile-window"[\s\S]*ytpToggleMinimize\(\)[\s\S]*closeYTPlayer\(\)/);
  // The sheet has no window buttons: it has a grab bar, and the constants that
  // were defined for the gesture are the ones the gesture reads.
  assert.doesNotMatch(html, /ytp-md-window-controls/);
  assert.match(html, /_ytpGrabEl\.className = 'ytp-fs-grab';/);
  assert.match(html, /ytpWireSheetDrag\(_ytpGrabEl, \{ tapDismisses: true \}\)/);
  assert.match(html, /dy > YTP_FS_DISMISS_PX \|\| vel > YTP_FS_DISMISS_SPEED/);
  assert.doesNotMatch(html, /\.ytp-fs-grab \{ display: none !important; \}/);
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

test('the phone Now Playing deck is title row, scrubber, transport and Lyrics / Up Next only', () => {
  const from = html.indexOf('function ytpMobDeckHTML(trackId) {');
  const deck = html.slice(from, html.indexOf('\n}\n', from));
  assert.ok(from > 0, 'could not locate the phone deck');
  const order = ['ytp-md-head', 'ytp-md-title', 'ytp-md-reaction-rail', 'ytp-md-more', 'ytp-md-seek', 'ytp-md-playpause', 'ytp-md-tab-lyrics', 'ytp-md-tab-playlist'];
  let at = -1;
  for (const id of order) {
    const i = deck.indexOf(id);
    assert.ok(i > at, id + ' is missing or out of order');
    at = i;
  }
  // No chip row and no window buttons: those moved into ⋯ or became the gesture.
  assert.doesNotMatch(deck, /ytp-md-chip|ytp-md-window|ytpCloseToMini|ytpToggleFullscreen/);
  // ⋯ carries Background Play and Versions for the track that is playing.
  assert.match(html, /function sjmPlayerSectionHTML\(tid\) \{[\s\S]*taToggleAudioMode\(\)[\s\S]*ytpToggleVersionMenu\(\)/);
  assert.match(html, /_sjmHeader\(_sjmHdr\) \+\s*sjmPlayerSectionHTML\(tid\) \+/);
});
