// @suite Player queue
// @area Playback
// @covers ytQueueSignature, ytMoveToIndex, ytMoveAfterCurrent, ytPlayNextIndex in public/index.html
//
// A 2,600 song queue made every player update cost half a second of blocked
// main thread, and moving a row by arithmetic pointed the player at somebody
// else's song. Both fixes are load-bearing and neither is visible from the
// outside: a signature that is missing a field silently costs a listener their
// name on a row, and an index re-found by arithmetic silently plays the wrong
// track. These pin both down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, dashboardHtml, htmlSlice } from './_load.mjs';

const song = (id, over = {}) => ({
  trackId: id,
  videoId: 'v-' + id,
  title: 'Song ' + id,
  artist: 'Band',
  ...over,
});

function sigOf(queue) {
  const { ytQueueSignature } = loadHtmlFnsInScope(['ytQueueSignature'], { ytQueue: queue });
  return ytQueueSignature();
}

// ── What a rendered list was built from ───────────────────────────────────

test('the signature changes when the songs or their order change', () => {
  const a = [song('1'), song('2')];
  assert.equal(sigOf(a), sigOf([song('1'), song('2')]), 'the same queue is the same signature');
  assert.notEqual(sigOf(a), sigOf([song('2'), song('1')]), 'order decides what the rows say');
  assert.notEqual(sigOf(a), sigOf([song('1')]), 'a removal has to repaint');
  assert.notEqual(sigOf(a), sigOf([song('1'), song('3')]));
});

test('an artist name hydrated in afterwards repaints the list', () => {
  const before = [song('1', { artist: '' })];
  const after = [song('1', { artist: 'Silver Jews' })];
  assert.notEqual(sigOf(before), sigOf(after));
});

test('a version swap on the same song repaints, because the row carries the video', () => {
  assert.notEqual(sigOf([song('1')]), sigOf([song('1', { videoId: 'v-live' })]));
});

test('the Online Jukebox credit is in the signature, or somebody loses their name', () => {
  // sjjAdopt() sets addedBy on a row that was ALREADY in the queue. Leave the
  // credit out of the signature and the row never repaints to show it.
  const plain = [song('1')];
  assert.notEqual(sigOf(plain), sigOf([song('1', { addedBy: 'Renee' })]));
  assert.notEqual(
    sigOf([song('1', { addedBy: 'Renee' })]),
    sigOf([song('1', { addedBy: 'Renee', addedByOwner: true })]),
  );
});

test('a rating is deliberately not in the signature', () => {
  // Ratings repaint in place through refreshVoteUI(); rebuilding 2,600 rows
  // because somebody pressed a thumb is what this whole mechanism exists to
  // avoid.
  assert.equal(sigOf([song('1')]), sigOf([song('1', { myVote: 1, hearts: 3 })]));
});

test('the queue list and the dock list hold separate signatures of one shared value', () => {
  // The dock is a SECOND copy of the list and it paints before updateYTQueueUI
  // reaches its own guard, so it still needs its own remembered signature - but
  // the value is built ONCE per update and handed down. Building it twice walked
  // the whole queue twice for an answer that cannot have changed in between.
  assert.match(dashboardHtml, /let _ytQueueSig = null;/);
  assert.match(dashboardHtml, /let _ytpDockPlaylistSig = null;/);
  const update = htmlSlice('function updateYTQueueUI(opts)', '\nfunction ');
  assert.equal(
    (update.match(/ytQueueSignature\(\)/g) || []).length, 1,
    'one signature per update, not one per list',
  );
  assert.match(update, /ytpPaintDockPlaylist\(queueSig\)/);
  const dock = htmlSlice('function ytpPaintDockPlaylist(sig, fromSync)', '\nfunction ');
  assert.match(dock, /sig === _ytpDockPlaylistSig/);
});

test('a row already carrying its artist never pays for a catalogue scan', () => {
  // ytpTrackMeta scans the whole catalogue AND scans ytQueue. Called once per
  // row it made the render quadratic. There is now exactly one place that can
  // make that call, and both lists read their names through it.
  const label = htmlSlice('function ytQueueLabelAt(i)', '\nfunction ');
  assert.match(label, /item\.trackId && !item\.artist/);
  assert.match(label, /ytpTrackMeta\(item\.trackId, item\.title, null, item\)/);
  const dock = htmlSlice('function ytpDockRowHTML(i)', '\nfunction ');
  assert.doesNotMatch(dock, /ytpTrackMeta\(/, 'the dock reads names through ytQueueLabelAt');
  const row = htmlSlice('function ytQueueRowHTML(i)', '\nfunction ');
  assert.doesNotMatch(row, /ytpTrackMeta\(/, 'so does the player list');
});

// ── Moving a row without losing the song on screen ────────────────────────

function mover(queue, idx) {
  const scope = {
    ytQueue: queue,
    ytQueueIdx: idx,
    updateYTQueueUI() {},
    Math,
  };
  const fns = loadHtmlFnsInScope(['ytMoveToIndex', 'ytMoveAfterCurrent'], scope);
  return { ...fns, scope };
}

test('moving a song from below the playing one to above it keeps the player on the same track', () => {
  // The old ytMoveQueue() only ever swapped neighbours, so a long move across
  // the playing row left ytQueueIdx pointing at somebody else's song.
  const queue = ['a', 'b', 'c', 'd', 'e'].map((id) => song(id));
  const { ytMoveToIndex, scope } = mover(queue, 2);
  const playing = queue[2];
  ytMoveToIndex(4, 0);
  assert.equal(scope.ytQueue[scope.ytQueueIdx], playing, 'the player must still be on the same song');
  assert.deepStrictEqual(scope.ytQueue.map((s) => s.trackId), ['e', 'a', 'b', 'c', 'd']);
});

test('moving a song from above the playing one to below it keeps the player on the same track', () => {
  const queue = ['a', 'b', 'c', 'd', 'e'].map((id) => song(id));
  const { ytMoveToIndex, scope } = mover(queue, 2);
  const playing = queue[2];
  ytMoveToIndex(0, 4);
  assert.equal(scope.ytQueue[scope.ytQueueIdx], playing);
  assert.deepStrictEqual(scope.ytQueue.map((s) => s.trackId), ['b', 'c', 'd', 'e', 'a']);
});

test('Play next from below the playing song lands directly behind it, not one place too far', () => {
  // The destination has to be worked out AFTER the row is lifted out: taking a
  // song from below shifts everything down.
  const queue = ['a', 'b', 'c', 'd', 'e'].map((id) => song(id));
  const { ytMoveAfterCurrent, scope } = mover(queue, 1);
  const at = ytMoveAfterCurrent(4);
  assert.equal(at, 2);
  assert.deepStrictEqual(scope.ytQueue.map((s) => s.trackId), ['a', 'b', 'e', 'c', 'd']);
  assert.equal(scope.ytQueueIdx, 1);
});

test('Play next from above the playing song also lands directly behind it', () => {
  const queue = ['a', 'b', 'c', 'd'].map((id) => song(id));
  const { ytMoveAfterCurrent, scope } = mover(queue, 2);
  const at = ytMoveAfterCurrent(0);
  assert.deepStrictEqual(scope.ytQueue.map((s) => s.trackId), ['b', 'c', 'a', 'd']);
  assert.equal(at, 2);
  assert.equal(scope.ytQueue[scope.ytQueueIdx].trackId, 'c');
});

test('a move that is out of range does nothing at all', () => {
  const queue = [song('a'), song('b')];
  const { ytMoveToIndex, ytMoveAfterCurrent, scope } = mover(queue, 0);
  assert.equal(ytMoveToIndex(9, 0), -1);
  assert.equal(ytMoveAfterCurrent(-1), -1);
  assert.deepStrictEqual(scope.ytQueue.map((s) => s.trackId), ['a', 'b']);
});

// ── Play next is an override, not a position ──────────────────────────────

function nextFinder(queue, idx, wanted) {
  const scope = { ytQueue: queue, ytQueueIdx: idx, _ytPlayNext: wanted };
  const fns = loadHtmlFnsInScope(['ytPlayNextIndex', 'ytSetPlayNext'], scope);
  return { ...fns, scope };
}

test('Play next holds the identity of a song, never an index', () => {
  // The queue is spliced under it constantly, so an index would go stale.
  const queue = ['a', 'b', 'c'].map((id) => song(id));
  const { ytSetPlayNext, scope } = nextFinder(queue, 0, null);
  ytSetPlayNext({ trackId: 'c', videoId: 'v-c', jbItemId: null, title: 'ignored' });
  assert.deepStrictEqual(scope._ytPlayNext, { jbItemId: null, trackId: 'c', videoId: 'v-c' });
});

test('the pinned song is found again after the queue has been shuffled under it', () => {
  const queue = ['c', 'a', 'b'].map((id) => song(id));
  const { ytPlayNextIndex } = nextFinder(queue, 1, { trackId: 'b', videoId: null, jbItemId: null });
  assert.equal(ytPlayNextIndex(), 2);
});

test('a room queue row is matched by its room id first, so two copies do not confuse it', () => {
  const queue = [song('a', { jbItemId: 'q1' }), song('a', { jbItemId: 'q2' })];
  const { ytPlayNextIndex } = nextFinder(queue, 0, { jbItemId: 'q2', trackId: 'a', videoId: null });
  assert.equal(ytPlayNextIndex(), 1);
});

test('an instruction that has been carried out, or can no longer be, clears itself', () => {
  const gone = nextFinder(['a', 'b'].map((id) => song(id)), 0, { trackId: 'zz', videoId: null, jbItemId: null });
  assert.equal(gone.ytPlayNextIndex(), -1);
  assert.equal(gone.scope._ytPlayNext, null);

  const playingIt = nextFinder(['a', 'b'].map((id) => song(id)), 1, { trackId: 'b', videoId: null, jbItemId: null });
  assert.equal(playingIt.ytPlayNextIndex(), -1);
  assert.equal(playingIt.scope._ytPlayNext, null);
});

test('every place that chooses a next song consults the override', () => {
  // Position alone was never enough: with shuffle on, ytNextTrack asks for a
  // random row, so moving a song to ytQueueIdx + 1 does nothing. Miss one of
  // these and Play next works only some of the time. (The crossfade path was
  // one of these until crossfade was removed; the DJ deck replaced it.)
  for (const fn of [
    'function ytNextTrack()',
    'function ytUpNextIndex()',
    'function taAdvanceBg()',
    'async function djOnDeckEnded(',
  ]) {
    assert.match(htmlSlice(fn, '\nfunction '), /ytPlayNextIndex\(\)/, fn + ' no longer honours Play next');
  }
});

test('skipping means not that one, even when it was pinned by hand', () => {
  assert.match(htmlSlice('function ytSkipUpNext()', '\nfunction '), /_ytPlayNext = null;/);
});
