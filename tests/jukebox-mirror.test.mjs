// @suite Host queue mirror
// @area Online Jukebox
// @covers src/lib/jukebox.ts reconcileHostQueue
//
// The room's queue IS the host's ytQueue seen from outside. The host pushes its
// whole queue every five seconds and reconcileHostQueue works out the
// difference. The awkward part is telling a song the host DELETED apart from a
// song a guest added a second ago, and getting that backwards means a host who
// reloads their tab wipes the whole room's requests. These cover both sides of
// that line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

const jb = loadTs('src/lib/jukebox.ts');

const SNAPSHOT = 1_000_000;

const item = (index, over = {}) => ({
  index,
  itemId: null,
  trackId: 't' + index,
  videoId: 'v' + index,
  ...over,
});

const row = (id, over = {}) => ({
  id,
  trackId: 't-' + id,
  videoId: 'v-' + id,
  sort: 1024,
  status: 'pending',
  createdAt: SNAPSHOT - 60_000,
  movedAt: null,
  ...over,
});

const plan = (opts) =>
  jb.reconcileHostQueue({ currentIndex: -1, existing: [], snapshotAtMs: SNAPSHOT, ...opts });

test('status is derived from position alone, so there is no advance call to get out of step', () => {
  assert.equal(jb.statusForIndex(0, 2), 'played');
  assert.equal(jb.statusForIndex(1, 2), 'played');
  assert.equal(jb.statusForIndex(2, 2), 'playing');
  assert.equal(jb.statusForIndex(3, 2), 'pending');
  assert.equal(jb.statusForIndex(0, -1), 'pending', 'nothing playing means nothing has played');
});

test('a first push writes the queue in, one row per song, with room to drag between', () => {
  const p = plan({ items: [item(0), item(1), item(2)], currentIndex: 1 });
  assert.equal(p.insert.length, 2, 'the song already behind us is not written in');
  assert.deepStrictEqual(p.insert.map((r) => r.status), ['playing', 'pending']);
  assert.deepStrictEqual(p.insert.map((r) => r.sort), [2048, 3072]);
  assert.deepStrictEqual(p.remove, []);
  assert.deepStrictEqual(p.adopt, []);
});

test('a song the host played before the room existed is never written in', () => {
  // A host reloading its tab pushes a queue with fifty songs behind the marker.
  // Inserting those would invent a "recently played" history the room never had.
  const items = Array.from({ length: 50 }, (_, i) => item(i));
  const p = plan({ items, currentIndex: 49 });
  assert.equal(p.insert.length, 1);
  assert.equal(p.insert[0].status, 'playing');
});

test('a song with no catalogue track is not mirrorable and stays private to the host', () => {
  const p = plan({ items: [item(0, { trackId: null })], currentIndex: 0 });
  assert.deepStrictEqual(p.insert, []);
});

test('in the steady state a host pushing the same queue writes nothing at all', () => {
  const existing = [
    row('a', { sort: 1024, status: 'playing' }),
    row('b', { sort: 2048, status: 'pending' }),
  ];
  const p = plan({
    items: [item(0, { itemId: 'a', trackId: 't-a' }), item(1, { itemId: 'b', trackId: 't-b' })],
    currentIndex: 0,
    existing,
  });
  assert.deepStrictEqual(p, { insert: [], update: [], remove: [], adopt: [], drop: [], reorder: [] });
});

test('a track change writes the two rows that moved and nothing else', () => {
  const existing = [
    row('a', { sort: 1024, status: 'playing' }),
    row('b', { sort: 2048, status: 'pending' }),
    row('c', { sort: 3072, status: 'pending' }),
  ];
  const p = plan({
    items: [
      item(0, { itemId: 'a', trackId: 't-a' }),
      item(1, { itemId: 'b', trackId: 't-b' }),
      item(2, { itemId: 'c', trackId: 't-c' }),
    ],
    currentIndex: 1,
    existing,
  });
  assert.deepStrictEqual(p.update, [
    { id: 'a', sort: 1024, status: 'played' },
    { id: 'b', sort: 2048, status: 'playing' },
  ]);
});

test('a row created since the host last checked in is a guest add, so it is adopted', () => {
  const guestAdd = row('new', { createdAt: SNAPSHOT + 1 });
  const p = plan({ items: [], existing: [guestAdd] });
  assert.deepStrictEqual(p.adopt, ['new']);
  assert.deepStrictEqual(p.remove, []);
});

test('a row the host used to have and no longer sends is a deletion to honour', () => {
  const stale = row('gone', { createdAt: SNAPSHOT - 1 });
  const p = plan({ items: [], existing: [stale] });
  assert.deepStrictEqual(p.remove, ['gone']);
  assert.deepStrictEqual(p.adopt, []);
});

test('a host that just reloaded adopts everything and sweeps nothing', () => {
  // A sync with no `since` uses 0. Get this backwards and a page refresh
  // deletes the whole room's queue.
  const rows = [row('a', { createdAt: 10 }), row('b', { createdAt: 20 })];
  const p = jb.reconcileHostQueue({ items: [], currentIndex: -1, existing: rows, snapshotAtMs: 0 });
  assert.deepStrictEqual(p.adopt.sort(), ['a', 'b']);
  assert.deepStrictEqual(p.remove, []);
});

test('a song already taken out of the room wins over a host still holding it', () => {
  const removed = row('r', { status: 'removed' });
  const p = plan({ items: [item(0, { itemId: 'r', trackId: 't-r' })], currentIndex: 0, existing: [removed] });
  assert.deepStrictEqual(p.drop, ['r']);
  assert.deepStrictEqual(p.update, []);
  assert.deepStrictEqual(p.insert, []);
});

test('a row a guest dragged since the last push is left alone, not snapped home', () => {
  const dragged = row('b', { sort: 1500, movedAt: SNAPSHOT + 500 });
  const existing = [row('a', { sort: 1024, status: 'playing' }), dragged, row('c', { sort: 3072 })];
  const p = plan({
    items: [
      item(0, { itemId: 'a', trackId: 't-a' }),
      item(1, { itemId: 'c', trackId: 't-c' }),
      item(2, { itemId: 'b', trackId: 't-b' }),
    ],
    currentIndex: 0,
    existing,
  });
  assert.ok(!p.update.some((u) => u.id === 'b'), 'the drag is the room answer, not a difference to correct');
  assert.deepStrictEqual(p.reorder, [{ id: 'b', trackId: 't-b', afterId: 'a' }]);
});

test('a drag to the very front of the waiting list reports no song to sit behind', () => {
  const dragged = row('b', { sort: 100, movedAt: SNAPSHOT + 500 });
  const p = plan({
    items: [item(0, { itemId: 'b', trackId: 't-b' })],
    currentIndex: 0,
    existing: [dragged],
  });
  assert.deepStrictEqual(p.reorder, [{ id: 'b', trackId: 't-b', afterId: null }]);
});

test('a played or removed row is never swept, only pending and playing ones', () => {
  const existing = [
    row('played', { status: 'played', createdAt: SNAPSHOT - 1 }),
    row('removed', { status: 'removed', createdAt: SNAPSHOT - 1 }),
    row('waiting', { createdAt: SNAPSHOT - 1 }),
  ];
  const p = plan({ items: [], existing });
  assert.deepStrictEqual(p.remove, ['waiting']);
});
