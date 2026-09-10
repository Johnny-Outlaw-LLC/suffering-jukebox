// @suite Online Jukebox rules
// @area Online Jukebox
// @covers src/lib/jukebox.ts
//
// src/lib/jukebox.ts is the single source of truth for whether an action in a
// room is allowed. The guest app, the host console and every /api/jukebox route
// read it, so a rule that is wrong here is wrong in three places at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

const jb = loadTs('src/lib/jukebox.ts');

const settings = (over = {}) => jb.normalizeSettings(over);
const pending = (...rows) =>
  rows.map(([id, sort, guestId, trackId]) => ({ id, sort, guestId, trackId }));

// ── Settings ──────────────────────────────────────────────────────────────

test('an empty settings blob is the documented default', () => {
  assert.deepStrictEqual(jb.normalizeSettings(undefined), {
    maxPendingPerGuest: 3,
    allowGuestImports: false,
    guestsFirst: false,
    allowGuestReorder: false,
  });
  assert.deepStrictEqual(jb.normalizeSettings(null), jb.DEFAULT_SETTINGS);
});

test('the four settings that stopped being settings are simply not read', () => {
  // Old rows still carry these keys. Ignoring them is the whole migration, so
  // a normalized blob must never grow one back.
  const old = jb.normalizeSettings({
    maxPendingPerGuest: 5,
    allowExplicit: false,
    allowDuplicates: true,
    allowWhenOffline: true,
    fairness: 'round_robin',
  });
  assert.deepStrictEqual(Object.keys(old).sort(), [
    'allowGuestImports', 'allowGuestReorder', 'guestsFirst', 'maxPendingPerGuest',
  ]);
  assert.equal(old.maxPendingPerGuest, 5);
});

test('a nonsense per-guest cap is clamped rather than trusted', () => {
  assert.equal(settings({ maxPendingPerGuest: -4 }).maxPendingPerGuest, 0);
  assert.equal(settings({ maxPendingPerGuest: 9000 }).maxPendingPerGuest, 50);
  assert.equal(settings({ maxPendingPerGuest: 2.6 }).maxPendingPerGuest, 3);
  assert.equal(settings({ maxPendingPerGuest: 'three' }).maxPendingPerGuest, 3);
  assert.equal(settings({ maxPendingPerGuest: '4' }).maxPendingPerGuest, 4);
});

test('a non-boolean switch falls back instead of going truthy', () => {
  assert.equal(settings({ guestsFirst: 'yes' }).guestsFirst, false);
  assert.equal(settings({ guestsFirst: 1 }).guestsFirst, false);
  assert.equal(settings({ guestsFirst: true }).guestsFirst, true);
});

// ── Room codes ────────────────────────────────────────────────────────────

test('a room code avoids every character that is misread aloud', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    for (const ch of jb.generateCode()) seen.add(ch);
  }
  assert.equal(jb.generateCode().length, jb.CODE_LENGTH);
  for (const banned of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!seen.has(banned), banned + ' is too easy to mishear or mistype');
  }
});

test('generateCode spreads across its alphabet rather than repeating itself', () => {
  let n = 0;
  const code = jb.generateCode(() => (n++ % 31) / 31);
  assert.equal(code, 'ABCDEF');
});

test('normalizeCode forgives spacing and case but not a wrong length', () => {
  assert.equal(jb.normalizeCode(' ab-2 cd3 '), 'AB2CD3');
  assert.equal(jb.normalizeCode('ABC'), null);
  assert.equal(jb.normalizeCode('ABCDEFG'), null);
});

// ── Vanity addresses ──────────────────────────────────────────────────────

test('a vanity address is folded to something that survives being read aloud', () => {
  assert.deepStrictEqual(jb.normalizeVanitySlug('  /Outlaw Bar/  '), { ok: true, slug: 'outlaw-bar' });
  assert.deepStrictEqual(jb.normalizeVanitySlug('the__blue---room'), { ok: true, slug: 'the-blue-room' });
  assert.deepStrictEqual(jb.normalizeVanitySlug("Joe's Tap!"), { ok: true, slug: 'joes-tap' });
});

test('a vanity address may never shadow a page the app already owns', () => {
  for (const taken of ['help', 'about', 'share', 'privacy', 'settings', 'share-image']) {
    const res = jb.normalizeVanitySlug(taken);
    assert.equal(res.ok, false, taken + ' is a real page and must be refused');
    assert.match(res.message, /page on this site already/);
  }
  // The one-letter routes (/j/, /p/) are refused a step earlier, on length.
  for (const taken of ['j', 'p']) {
    assert.equal(jb.normalizeVanitySlug(taken).ok, false);
  }
});

test('a vanity address that is too short, too long or not text is refused', () => {
  assert.equal(jb.normalizeVanitySlug('ab').ok, false);
  assert.equal(jb.normalizeVanitySlug('x'.repeat(jb.MAX_SLUG + 1)).ok, false);
  assert.equal(jb.normalizeVanitySlug(null).ok, false);
  assert.equal(jb.normalizeVanitySlug('!!!').ok, false);
});

test('normalizeRoomKey stays looser than a code, because which one it is is a database question', () => {
  assert.equal(jb.normalizeRoomKey('/outlaw-bar/'), 'outlaw-bar');
  assert.equal(jb.normalizeRoomKey('AB2CD3'), 'AB2CD3');
  assert.equal(jb.normalizeRoomKey('no spaces here'), null);
  assert.equal(jb.normalizeRoomKey('ab'), null);
});

// ── Queue ordering ────────────────────────────────────────────────────────

test('appending always leaves a gap to drag something into', () => {
  assert.equal(jb.appendSort([]), 1024);
  assert.equal(jb.appendSort(pending(['a', 1024, null, 't1'], ['b', 3072, null, 't2'])), 4096);
});

test('a midpoint lands strictly between its neighbours', () => {
  assert.equal(jb.midpointSort(1024, 2048), 1536);
  assert.equal(jb.midpointSort(null, null), 1024);
  assert.ok(jb.midpointSort(null, 1024) < 1024);
  assert.ok(jb.midpointSort(1024, null) > 1024);
});

test('guests first means in front of the host, never in front of the song on screen', () => {
  const rows = pending(
    ['playing', 1000, null, 't-now'],
    ['host-1', 2000, null, 't-host'],
    ['host-2', 3000, null, 't-host2'],
  );
  const sort = jb.guestsFirstSort(rows);
  assert.ok(sort > 1000, 'nothing goes in front of what everybody is listening to');
  assert.ok(sort < 2000, 'and it goes in front of the host own list');
});

test('guests first is not last-in-first-out: an earlier request keeps its place', () => {
  const rows = pending(
    ['playing', 1000, null, 't-now'],
    ['guest-a', 1500, 'g1', 't-a'],
    ['host-1', 2000, null, 't-host'],
  );
  const sort = jb.guestsFirstSort(rows);
  assert.ok(sort > 1500, 'jumping the person who asked first would be a worse jukebox');
  assert.ok(sort < 2000);
});

test('guests first on an empty room is just the first slot', () => {
  assert.equal(jb.guestsFirstSort([]), 1024);
});

// ── The add rule ──────────────────────────────────────────────────────────

const addCtx = (over = {}) => ({
  isLive: true,
  settings: jb.DEFAULT_SETTINGS,
  guestBanned: false,
  pending: [],
  guestId: 'g1',
  trackId: 't-new',
  isOwner: false,
  ...over,
});

test('a banned guest is refused before anything else is considered', () => {
  const res = jb.decideAdd(addCtx({ guestBanned: true, isOwner: true, isLive: false }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'banned');
});

test('adding while the room is off air is never allowed, and is not a setting', () => {
  const res = jb.decideAdd(addCtx({ isLive: false }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'offline');
  // The owner is loading their own player, which is how a room gets going.
  assert.equal(jb.decideAdd(addCtx({ isLive: false, isOwner: true })).ok, true);
});

test('the same song twice is never allowed, for a guest or for the owner', () => {
  const rows = pending(['a', 1024, 'g2', 't-new']);
  for (const isOwner of [false, true]) {
    const res = jb.decideAdd(addCtx({ pending: rows, isOwner }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'duplicate');
  }
});

test('the per-guest cap counts only that guest, and the owner is exempt', () => {
  const mine = pending(
    ['a', 1024, 'g1', 't1'], ['b', 2048, 'g1', 't2'], ['c', 3072, 'g1', 't3'],
    ['d', 4096, 'g2', 't4'], ['e', 5120, null, 't5'],
  );
  const capped = jb.decideAdd(addCtx({ pending: mine }));
  assert.equal(capped.ok, false);
  assert.equal(capped.code, 'cap');
  assert.match(capped.message, /already have 3 songs waiting/);

  assert.equal(jb.decideAdd(addCtx({ pending: mine, guestId: 'g2' })).ok, true);
  assert.equal(jb.decideAdd(addCtx({ pending: mine, isOwner: true })).ok, true);
  assert.equal(
    jb.decideAdd(addCtx({ pending: mine, settings: settings({ maxPendingPerGuest: 0 }) })).ok,
    true,
    'zero means unlimited, not none',
  );
});

test('the cap message counts in words that match the number', () => {
  const one = jb.decideAdd(addCtx({
    settings: settings({ maxPendingPerGuest: 1 }),
    pending: pending(['a', 1024, 'g1', 't1']),
  }));
  assert.match(one.message, /already have 1 song waiting/);
});

test('the room has a hard ceiling so a runaway insert cannot fill the table', () => {
  const rows = Array.from({ length: jb.MAX_PENDING_TOTAL }, (_, i) => ({
    id: 'r' + i, sort: i * 1024, guestId: null, trackId: 'x' + i,
  }));
  const res = jb.decideAdd(addCtx({ pending: rows, isOwner: true }));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'queue_full');
});

test('an allowed add lands where the host setting says it should', () => {
  const rows = pending(['playing', 1000, null, 't-now'], ['host', 2000, null, 't-host']);
  const behind = jb.decideAdd(addCtx({ pending: rows }));
  assert.equal(behind.sort, 3024, 'by default a request goes on the end');

  const infront = jb.decideAdd(addCtx({ pending: rows, settings: settings({ guestsFirst: true }) }));
  assert.ok(infront.sort > 1000 && infront.sort < 2000);

  const owner = jb.decideAdd(addCtx({
    pending: rows, isOwner: true, settings: settings({ guestsFirst: true }),
  }));
  assert.equal(owner.sort, 3024, 'the host own adds always go on the end; it is their list');
});

// ── What a guest may touch ────────────────────────────────────────────────

test('a guest may pull back their own waiting song and nothing else', () => {
  assert.equal(jb.canGuestRemove({ guestId: 'g1', status: 'pending' }, 'g1'), true);
  assert.equal(jb.canGuestRemove({ guestId: 'g2', status: 'pending' }, 'g1'), false);
  assert.equal(jb.canGuestRemove({ guestId: 'g1', status: 'playing' }, 'g1'), false);
  assert.equal(jb.canGuestRemove({ guestId: null, status: 'pending' }, 'g1'), false);
});

test('reordering needs the switch on, the room live, and a song that is waiting', () => {
  const on = settings({ allowGuestReorder: true });
  const base = { settings: on, isLive: true, guestBanned: false, status: 'pending' };
  assert.equal(jb.canGuestReorder(base), true);
  assert.equal(jb.canGuestReorder({ ...base, settings: jb.DEFAULT_SETTINGS }), false);
  assert.equal(jb.canGuestReorder({ ...base, isLive: false }), false);
  assert.equal(jb.canGuestReorder({ ...base, guestBanned: true }), false);
  assert.equal(
    jb.canGuestReorder({ ...base, status: 'playing' }), false,
    'the song on screen is not a queue position',
  );
});

test('one jukebox per account is a constant, not a unique index', () => {
  assert.equal(jb.MAX_JUKEBOXES_PER_ACCOUNT, 1);
});
