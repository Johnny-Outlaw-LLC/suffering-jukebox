// @suite Phone player and My Artists
// @area Playback
// @covers the phone player sheet and Add to My Artists in public/index.html
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const lpHelp = readFileSync(new URL('../public/help/lp/index.html', import.meta.url), 'utf8');

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

test('mobile artist cards move Explore Artist Discography into the more menu', () => {
  const from = html.indexOf('function lamRender(row)');
  const to = html.indexOf('// Every song this artist has', from);
  const menu = html.slice(from, to);
  assert.match(menu, /onclick="lamExplore\(\)"[\s\S]*Explore Artist Discography/);
  assert.match(menu, /function lamExplore\(\)[\s\S]*landingExploreArtist\(row\.slug, row\.artist_id\)/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.landing-discography-btn \{ display: none !important; \}/);
  assert.match(html, /class="landing-explore-btn landing-discography-btn"/);
});

test('full-detail mobile artist stats use a readable two-by-two grid', () => {
  assert.match(html, /\.landing-grid\.detail-full \.landing-card-stats \{\s*display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.landing-grid\.detail-full \.landing-card-stats \.landing-stat-lbl \{[\s\S]*?white-space: normal/);
});

test('native account tools stay in the app navigation stack', () => {
  assert.match(html, /function openFaq\(\)[\s\S]*if \(sjIsNative\(\)\) \{[\s\S]*window\.location\.assign\('\/help\/lp\/index\.html'\)/);
  assert.match(html, /async function openAnalyticsInNewTab\(\) \{\s*return openHostedToolInNewTab\('\/analytics'\);/);
  assert.match(html, /async function openHostedToolInNewTab\(path\) \{\s*if \(sjIsNative\(\)\) \{\s*await sjOpenHostedTool\(path\);/);
  assert.match(html, /action === 'studio'[\s\S]*sjOpenHostedTool\('\/artist-discography-upload'\)/);
  assert.match(html, /#sj-app-session=/, 'hosted tools need the native session handoff');
});

test('native Help clears the status bar and provides an in-app Back button', () => {
  assert.match(lpHelp, /viewport-fit=cover/);
  assert.match(lpHelp, /env\(safe-area-inset-top, 0px\)/);
  assert.match(lpHelp, /id="nativeBack"/);
  assert.match(lpHelp, /window\.Capacitor[\s\S]*document\.documentElement\.classList\.add\('native-shell'\)/);
  assert.match(lpHelp, /window\.history\.back\(\)/);
});

test('playlist and artist management share the iOS sheet treatment', () => {
  assert.match(html, /html\.sj-ios \.pl-modal-overlay/);
  assert.match(html, /html\.sj-ios #plModalOverlay \.pl-row-hdr/);
  assert.match(html, /html\.sj-ios #myArtistsOverlay \.ma-list-row/);
  assert.match(html, /html\.sj-ios #myArtistsOverlay :is\(\.oa-act,\.ma-artist-tools \.oa-act\)/);
});

test('What’s New calls the shipped feed APP UPDATES', () => {
  assert.match(html, /\['updates',\s+'APP UPDATES'\]/);
});

test('the phone Now Playing deck is title row, scrubber, transport and Up Next / Lyrics only', () => {
  const from = html.indexOf('function ytpMobDeckHTML(trackId) {');
  const deck = html.slice(from, html.indexOf('\n}\n', from));
  assert.ok(from > 0, 'could not locate the phone deck');
  // Up Next leads, as in YouTube Music. ⋯ lives in the sheet's top bar.
  const order = ['ytp-md-head', 'ytp-md-title', 'ytp-md-reaction-rail', 'ytp-md-seek', 'ytp-md-playpause', 'ytp-md-tab-playlist', 'ytp-md-tab-lyrics'];
  let at = -1;
  for (const id of order) {
    const i = deck.indexOf(id);
    assert.ok(i > at, id + ' is missing or out of order');
    at = i;
  }
  assert.match(html, /class="ytp-fs-more-btn" id="ytp-md-more" data-sheet-ignore/);
  // The Up Next line (with Skip) sits between transport and the tabs.
  assert.ok(deck.indexOf('ytp-md-playpause') < deck.indexOf('ytp-md-up-next') &&
    deck.indexOf('ytp-md-up-next') < deck.indexOf('ytp-md-tab-playlist'), 'Up Next line is misplaced');
  // No chip row and no window buttons: those moved into ⋯ or became the gesture.
  assert.doesNotMatch(deck, /ytp-md-chip|ytp-md-window|ytpCloseToMini|ytpToggleFullscreen/);
  // ⋯ carries Background Play and Versions for the track that is playing.
  assert.match(html, /function sjmPlayerSectionHTML\(tid\) \{[\s\S]*taToggleAudioMode\(\)[\s\S]*ytpToggleVersionMenu\(\)/);
  assert.match(html, /_sjmHeader\(_sjmHdr\) \+\s*sjmPlayerSectionHTML\(tid\) \+/);
});
