// @suite Queue windowing
// @area Playback
// @covers ytQueueWindowFor, ytQueueVisibleIdx, ytQueueFindText, ytQueueRowHTML, ytQueueLabelAt in public/index.html
//
// A 796 song queue drawn whole was 320ms to 2.5s of blocked main thread on
// every genuine queue change, and the perf log says that happened 125 times in
// three days. Only the rows near the viewport are drawn now.
//
// Two things make that safe and neither is visible from the outside. The window
// arithmetic has to account for the sticky header sitting above the rows inside
// the same scroller, or every row is off by the height of that header. And the
// search filter has to run against the MODEL - it used to hide rows in the DOM,
// which is exactly what forced all 796 of them to exist. These pin both down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, dashboardHtml, htmlSlice } from './_load.mjs';

const OVERSCAN = 12; // SJ_QLIST_OVERSCAN
const MIN = 24;      // SJ_QLIST_MIN

const song = (id, over = {}) => ({
  trackId: id,
  videoId: 'v-' + id,
  title: 'Song ' + id,
  artist: 'Band',
  ...over,
});

function windower() {
  return loadHtmlFnsInScope(['ytQueueWindowFor'], {
    Math,
    SJ_QLIST_OVERSCAN: OVERSCAN,
    SJ_QLIST_MIN: MIN,
  });
}

// ── Which rows get drawn ──────────────────────────────────────────────────

test('the constants the window is built from are the ones the tests assume', () => {
  // These are read out of the page rather than imported, so a change to either
  // has to come back here and be thought about.
  assert.match(dashboardHtml, new RegExp(`const SJ_QLIST_OVERSCAN = ${OVERSCAN};`));
  assert.match(dashboardHtml, new RegExp(`const SJ_QLIST_MIN      = ${MIN};`));
});

test('a queue of any length draws a bounded number of rows', () => {
  // The whole point. 796 rows was ~800KB of markup per rebuild.
  const { ytQueueWindowFor } = windower();
  for (const total of [100, 796, 2647, 50000]) {
    const w = ytQueueWindowFor(0, 280, 40, 26, total);
    assert.ok(w.end - w.start <= MIN + OVERSCAN * 2 + 12,
      `drew ${w.end - w.start} rows of ${total}`);
  }
});

test('at the top of the list the window starts at the first row', () => {
  const { ytQueueWindowFor } = windower();
  const w = ytQueueWindowFor(0, 280, 40, 26, 796);
  assert.equal(w.start, 0);
  assert.ok(w.end >= Math.ceil(280 / 26), 'the viewport is covered');
});

test('the sticky header is subtracted, or every row is off by its height', () => {
  // .yt-queue-sticky is INSIDE the scroller, above the rows, so a scrollTop of
  // exactly the header height is still showing row zero. Miss this and the list
  // is short by a header on every scroll.
  const { ytQueueWindowFor } = windower();
  const head = 40;
  assert.equal(ytQueueWindowFor(head, 280, head, 26, 796).start, 0);
  assert.deepStrictEqual(
    ytQueueWindowFor(head, 280, head, 26, 796),
    ytQueueWindowFor(0, 280, 0, 26, 796),
    'a scrollTop of one header with a header is the same view as no scroll without one',
  );
});

test('scrolling down moves the window with the viewport', () => {
  const { ytQueueWindowFor } = windower();
  const rowH = 26;
  const w = ytQueueWindowFor(40 + 300 * rowH, 280, 40, rowH, 796);
  assert.equal(w.start, 300 - OVERSCAN);
  assert.ok(w.start < 300 && w.end > 300, 'row 300 is inside the window it was scrolled to');
});

test('the window never runs past the end of the list', () => {
  const { ytQueueWindowFor } = windower();
  const total = 796;
  const w = ytQueueWindowFor(40 + total * 26, 280, 40, 26, total);
  assert.equal(w.end, total);
  assert.ok(w.start >= 0);
  assert.ok(w.end - w.start >= Math.min(MIN, total), 'the last screen is still full');
});

test('a list shorter than the minimum window is drawn whole', () => {
  const { ytQueueWindowFor } = windower();
  const w = ytQueueWindowFor(0, 280, 40, 26, 5);
  assert.deepStrictEqual(w, { start: 0, end: 5 });
});

test('before a row has been measured the window is still big enough to measure one', () => {
  // _ytQueueRowH starts at 0. The first paint has to put real rows on screen or
  // there is nothing to read a height off, and the pads never get their size.
  const { ytQueueWindowFor } = windower();
  const w = ytQueueWindowFor(0, 280, 40, 0, 796);
  assert.equal(w.start, 0);
  assert.ok(w.end > 0, 'something has to be drawn to be measured');
});

test('an empty queue asks for no rows', () => {
  const { ytQueueWindowFor } = windower();
  assert.deepStrictEqual(ytQueueWindowFor(0, 280, 40, 26, 0), { start: 0, end: 0 });
});

// ── Searching filters the model, not the DOM ──────────────────────────────

function filterer(queue, filter) {
  const scope = {
    ytQueue: queue,
    _ytQueueFilter: filter,
    _ytQueueLabels: [],
    _ytQueueVis: null,
    _ytQueueVisQ: null,
    _ytQueueVisLen: -1,
    _ytQueueWinFrom: -1,
    _ytQueueWinTo: -1,
  };
  const fns = loadHtmlFnsInScope(['ytQueueVisibleIdx', 'ytQueueFindText'], scope);
  return { ...fns, scope };
}

test('with no filter every song is in the list', () => {
  const queue = ['a', 'b', 'c'].map((id) => song(id));
  const { ytQueueVisibleIdx } = filterer(queue, '');
  assert.deepStrictEqual(ytQueueVisibleIdx(), [0, 1, 2]);
});

test('the filter matches the artist and the title, case insensitively', () => {
  const queue = [
    song('1', { artist: 'Silver Jews', title: 'Random Rules' }),
    song('2', { artist: 'Pavement', title: 'Gold Soundz' }),
    song('3', { artist: 'Purple Mountains', title: 'All My Happiness is Gone' }),
  ];
  assert.deepStrictEqual(filterer(queue, 'pavement').ytQueueVisibleIdx(), [1]);
  assert.deepStrictEqual(filterer(queue, 'GOLD').ytQueueVisibleIdx(), [1]);
  assert.deepStrictEqual(filterer(queue, 'happiness').ytQueueVisibleIdx(), [2]);
  assert.deepStrictEqual(filterer(queue, 'zzz').ytQueueVisibleIdx(), []);
});

test('whitespace around the query is not part of it', () => {
  const queue = [song('1', { artist: 'Sebadoh', title: 'Rebound' })];
  assert.deepStrictEqual(filterer(queue, '  sebadoh  ').ytQueueVisibleIdx(), [0]);
});

test('the filtered index is remembered, and forgotten when the query moves', () => {
  const queue = ['a', 'b'].map((id) => song(id));
  const { ytQueueVisibleIdx, scope } = filterer(queue, '');
  const first = ytQueueVisibleIdx();
  assert.equal(ytQueueVisibleIdx(), first, 'the same query hands back the same array');
  scope._ytQueueFilter = 'song a';
  assert.deepStrictEqual(ytQueueVisibleIdx(), [0], 'a new query rebuilds it');
});

test('the filter never reaches for the catalogue', () => {
  // Searching must not trigger a per-row ytpTrackMeta scan: on a long queue
  // that is quadratic, which is the cost this whole change exists to remove.
  const find = htmlSlice('function ytQueueFindText(i)', '\nfunction ');
  assert.doesNotMatch(find, /ytpTrackMeta/);
  const visible = htmlSlice('function ytQueueVisibleIdx()', '\nfunction ');
  assert.doesNotMatch(visible, /ytpTrackMeta/);
});

test('a row whose artist has not been hydrated yet is still findable by title', () => {
  // ytpHydrateQueueMeta() fills item.artist in one batched lookup and repaints.
  // Until it lands the row still has to answer to its own name.
  const queue = [song('1', { artist: '', title: 'Trains Across the Sea' })];
  assert.deepStrictEqual(filterer(queue, 'trains').ytQueueVisibleIdx(), [0]);
});

// ── One row's markup ──────────────────────────────────────────────────────

function rower(queue, idx) {
  const scope = {
    ytQueue: queue,
    ytQueueIdx: idx,
    _ytQueueLabels: [],
    escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    voteClass: () => '',
    getMyVote: () => 0,
    VOTE_LABELS: { 0: '-' },
    ytpTrackMeta: () => ({ artist: 'From Catalogue', title: 'Resolved' }),
  };
  const fns = loadHtmlFnsInScope(['ytQueueRowHTML', 'ytQueueLabelAt'], scope);
  return { ...fns, scope };
}

test('a row carries the absolute queue index, not its place in the window', () => {
  // Everything downstream addresses rows by data-queue-idx, and the handlers
  // splice ytQueue by it. Numbering rows by their position in the window would
  // remove the wrong song.
  const queue = Array.from({ length: 50 }, (_, i) => song(String(i)));
  const { ytQueueRowHTML } = rower(queue, 0);
  const html = ytQueueRowHTML(37);
  assert.match(html, /data-queue-idx="37"/);
  assert.match(html, /ytPlayQueueIdx\(37\)/);
  assert.match(html, /ytRemoveFromQueue\(37\)/);
  assert.match(html, />38</, 'the number shown is one-based');
});

test('the playing row is the one marked active', () => {
  const queue = ['a', 'b', 'c'].map((id) => song(id));
  const { ytQueueRowHTML } = rower(queue, 1);
  assert.doesNotMatch(ytQueueRowHTML(0), /yt-queue-row active/);
  assert.match(ytQueueRowHTML(1), /yt-queue-row active/);
});

test('the reorder arrows are disabled at the ends of the queue', () => {
  const queue = ['a', 'b', 'c'].map((id) => song(id));
  const { ytQueueRowHTML } = rower(queue, 0);
  assert.equal((ytQueueRowHTML(0).match(/disabled/g) || []).length, 1, 'no up from the top');
  assert.equal((ytQueueRowHTML(1).match(/disabled/g) || []).length, 0);
  assert.equal((ytQueueRowHTML(2).match(/disabled/g) || []).length, 1, 'no down from the bottom');
});

test('a song title cannot close the row it is written into', () => {
  const queue = [song('1', { artist: 'A&M', title: '<script>alert(1)</script>' })];
  const { ytQueueRowHTML } = rower(queue, 0);
  const html = ytQueueRowHTML(0);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A&amp;M/);
});

test('the Online Jukebox credit survives, because a guest add lands on an existing row', () => {
  const queue = [song('1', { addedBy: 'Renee' }), song('2', { addedBy: 'Host', addedByOwner: true })];
  const { ytQueueRowHTML } = rower(queue, 0);
  assert.match(ytQueueRowHTML(0), /Added by Renee/);
  assert.doesNotMatch(ytQueueRowHTML(1), /Added by/, 'the host is not credited to themselves');
});

test('the catalogue is only asked about a row that has no artist, and only once', () => {
  let scans = 0;
  const queue = [song('1', { artist: '' }), song('2', { artist: 'Band' })];
  const scope = {
    ytQueue: queue,
    _ytQueueLabels: [],
    ytpTrackMeta: () => { scans++; return { artist: 'Silver Jews', title: 'Song 1' }; },
  };
  const { ytQueueLabelAt } = loadHtmlFnsInScope(['ytQueueLabelAt'], scope);
  assert.equal(ytQueueLabelAt(0).label, 'Silver Jews - Song 1');
  assert.equal(scans, 1);
  ytQueueLabelAt(0);
  assert.equal(scans, 1, 'the label is remembered, so redrawing a row is free');
  assert.equal(ytQueueLabelAt(1).label, 'Band - Song 2');
  assert.equal(scans, 1, 'a row that already knows its artist never asks');
});

// ── The wiring that makes it hold together ────────────────────────────────

test('the list body is not a map over the whole queue any more', () => {
  const update = htmlSlice('function updateYTQueueUI(opts)', '\nfunction ');
  assert.doesNotMatch(update, /\$\{ytQueue\.map\(/,
    'the markup for every row is exactly what windowing removed');
  assert.match(update, /<div class="yt-queue-rows" id="yt-queue-rows"><\/div>/);
});

test('the cached labels are dropped before either list paints, not after', () => {
  // The dock paints from the top of updateYTQueueUI and reads the same cache.
  // Resetting after the player list rebuilt left the dock a paint behind.
  const update = htmlSlice('function updateYTQueueUI(opts)', '\nfunction ');
  const reset = update.indexOf('ytQueueResetLabels()');
  const dock = update.indexOf('ytpPaintDockPlaylist(queueSig)');
  assert.ok(reset >= 0 && dock >= 0);
  assert.ok(reset < dock, 'the reset has to come first');
});

test('the scroll handler is wired to both lists and throttled to a frame', () => {
  assert.match(dashboardHtml, /class="yt-queue-section" onscroll="ytQueueOnScroll\(\)"/);
  assert.match(dashboardHtml, /id="ytp-mf-playlist"[^>]*onscroll="ytpDockPlaylistOnScroll\(\)"/);
  for (const fn of ['ytQueueOnScroll', 'ytpDockPlaylistOnScroll']) {
    const src = htmlSlice(`function ${fn}()`, '\nfunction ');
    assert.match(src, /requestAnimationFrame/, `${fn} must not render per scroll event`);
  }
});

test('scrolling to the playing song does not depend on finding its row', () => {
  // It is usually outside the window, so there is no element to scroll into
  // view. The position comes from the model instead.
  const src = htmlSlice('function ytScrollQueueToCurrent()', '\nfunction ');
  assert.match(src, /ytQueueVisibleIdx\(\)\.indexOf\(ytQueueIdx\)/);
  assert.match(src, /_ytQueueRowH/);
});

test('the dock list is left alone while it is hidden', () => {
  // It is display:none unless the dock is minimised, grown and tall enough.
  // Building 796 rows into it on every queue change bought nothing.
  const src = htmlSlice('function ytpPaintDockPlaylist(sig, fromSync)', '\nfunction ');
  assert.match(src, /if \(!ytpDockPlaylistShowing\(\)\)/);
  assert.match(src, /_ytpDockPlaylistSig = null;/, 'a hidden list is marked stale, not drawn');
  const sync = htmlSlice('function ytpDockSyncPlaylist()', '\nfunction ');
  assert.match(sync, /ytpPaintDockPlaylist\(null, true\)/,
    'whatever reveals the list has to draw it');
});

test('painting the dock cannot schedule the sync that painted it', () => {
  // paint schedules ytpDockSyncPlaylist, and sync now paints. Without the
  // fromSync guard those two call each other for ever.
  const src = htmlSlice('function ytpPaintDockPlaylist(sig, fromSync)', '\nfunction ');
  const scheduled = src.match(/requestAnimationFrame\(ytpDockSyncPlaylist\)/g) || [];
  assert.ok(scheduled.length > 0);
  assert.equal(
    (src.match(/!fromSync\) requestAnimationFrame\(ytpDockSyncPlaylist\)/g) || []).length,
    scheduled.length,
    'every one of those has to be guarded',
  );
});

test('the row menu re-anchors to a row it has brought back into the window', () => {
  const src = htmlSlice('function sjmQueueMove(delta)', '\nfunction ');
  assert.match(src, /ytQueueEnsureRendered\(to\)/);
});
