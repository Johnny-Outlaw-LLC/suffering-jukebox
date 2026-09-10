// @suite Shuffle weighting
// @area Playback
// @covers _ytWeightedShufflePick and the weighting engine in public/index.html
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const from = html.indexOf(startMarker);
  const to = html.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `could not locate ${startMarker}`);
  return html.slice(from, to);
}

const DAY = 86400000;
const iso = daysAgo => new Date(Date.now() - daysAgo * DAY).toISOString();

/** The weighting engine, with whatever listening history the test hands it. */
function engine({ preference, queue = [], plays = {}, lastPlayed = {}, votes = {}, recent = [] }) {
  const context = vm.createContext({
    sjShufflePreference: preference,
    ytQueue: queue.map(id => ({ trackId: id })),
    _ytShuffleRecent: recent.slice(),
    myInAppPlays: plays,
    myLastPlayed: lastPlayed,
    getMyVote: id => votes[id] || 0,
    Math, Date, Number, isFinite,
  });
  vm.runInContext(
    slice('const SJ_SHUFFLE_RECENT_MIN =', 'function _ytWeightedShufflePick('),
    context,
  );
  return context;
}

test('the recently played memory scales with what is actually loaded', () => {
  const depth = n => engine({
    preference: 'less_repeats',
    queue: Array.from({ length: n }, (_, i) => 't' + i),
  })._ytShuffleRecentDepth();

  assert.equal(depth(0), 4, 'floors at four, not zero');
  assert.equal(depth(8), 4, 'a short queue keeps the floor');
  assert.equal(depth(40), 10, 'a quarter of the queue');
  assert.equal(depth(4000), 100, 'and caps, so it never walks a huge list');
});

test('remembering a play keeps it newest-first without duplicating it', () => {
  const ctx = engine({ preference: 'less_repeats', queue: ['a', 'b', 'c', 'd'], recent: ['b', 'a'] });
  ctx._ytRememberShufflePlay('a');
  assert.equal(ctx._ytShuffleRecent.join(','), 'a,b');
  ctx._ytRememberShufflePlay('');
  assert.equal(ctx._ytShuffleRecent.join(','), 'a,b', 'a missing track id is not remembered');
});

test('Less Repeats ranks by how long it has been, not just by this session', () => {
  // The bug this covers: recency used to mean "one of the last four songs in
  // this tab". A song played into the ground yesterday looked brand new after
  // a page reload, which is exactly what "I keep hearing the same songs" is.
  const ctx = engine({
    preference: 'less_repeats',
    queue: ['today', 'lastWeek', 'longAgo', 'never'],
    lastPlayed: { today: iso(0.02), lastWeek: iso(7), longAgo: iso(60) },
  });
  const w = id => ctx._ytShuffleWeightFor(id);

  assert.ok(w('today') < w('lastWeek'), 'today is held back behind last week');
  assert.ok(w('lastWeek') < w('longAgo'), 'last week is held back behind two months ago');
  assert.ok(Math.abs(w('longAgo') - w('never')) < 0.01, 'past the cooling window, never and long ago tie');
  assert.ok(w('never') / w('today') > 20, 'and the gap is big enough to actually change what plays');
});

test('Discovery still holds back a song you have only just heard', () => {
  const ctx = engine({
    preference: 'discovery',
    queue: ['fresh', 'worn', 'justPlayed'],
    plays: { fresh: 0, worn: 100, justPlayed: 0 },
    lastPlayed: { worn: iso(90), justPlayed: iso(0.01) },
  });
  const w = id => ctx._ytShuffleWeightFor(id);
  assert.ok(w('fresh') > w('worn'), 'fewest plays still wins');
  assert.ok(w('justPlayed') < w('worn'),
    'a never-played song heard ten minutes ago is not "undiscovered" right now');
});

test('Favorites First still puts a favorite ahead, even a recent one', () => {
  const ctx = engine({
    preference: 'favorites',
    queue: ['fav', 'plain'],
    votes: { fav: 1 },
    lastPlayed: { fav: iso(0.01) },
  });
  // The damping is floored on purpose: hearing the same six favourites all
  // evening is the complaint, but a favourite must never fall behind a song
  // that was never rated at all.
  assert.ok(ctx._ytShuffleWeightFor('fav') > ctx._ytShuffleWeightFor('plain'));
});

test('No Preferences weighs nothing at all', () => {
  const ctx = engine({
    preference: 'none',
    queue: ['a', 'b'],
    plays: { a: 500 },
    lastPlayed: { a: iso(0) },
    votes: { b: 1 },
  });
  assert.equal(ctx._ytShuffleWeightFor('a'), 1);
  assert.equal(ctx._ytShuffleWeightFor('b'), 1);
});

test('a play from the car is labelled as CarPlay, not as background audio', () => {
  // CarPlay writes source 'audio' like any other locker playback, because it
  // IS locker playback and every chart already understands that word. The car
  // names itself in device_id instead, and this is the only reader of that.
  const context = vm.createContext({});
  vm.runInContext(slice('function sjLhWhere(row) {', '// The weight the picker is using'), context);
  const label = row => context.sjLhWhere(row).label;

  assert.equal(label({ source: 'audio', device_id: 'carplay:abc-123' }), 'CarPlay');
  assert.equal(label({ source: 'audio', device_id: 'abc-123' }), 'Background audio');
  assert.equal(label({ source: 'video', device_id: 'abc-123' }), 'Jukebox');
  assert.equal(label({ source: 'spotify' }), 'Spotify');
  assert.equal(label({}), 'Jukebox');
});
