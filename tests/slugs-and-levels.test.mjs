// @suite Playlist addresses and storage allowances
// @area Accounts
// @covers src/lib/playlist-slug.ts, src/lib/user-levels.ts
//
// Two small rules with published promises attached. A playlist address goes in
// somebody's bio, so it has to be stable and it must never collide with a page
// the app already owns. The storage allowance is printed on /help#how: 500 MB,
// everyone, while the site is being built out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, adminAuthStub, readRepoFile } from './_load.mjs';

const jb = loadTs('src/lib/jukebox.ts');
const slug = loadTs('src/lib/playlist-slug.ts', {
  'sj-admin-auth': adminAuthStub,
  '@/lib/jukebox': jb,
});
const levels = loadTs('src/lib/user-levels.ts', { 'sj-admin-auth': adminAuthStub });

// ── Playlist addresses ────────────────────────────────────────────────────

test('a playlist name becomes an address a person can type', () => {
  assert.equal(slug.slugifyPlaylistName('Songs for the Drive Home'), 'songs-for-the-drive-home');
  assert.equal(slug.slugifyPlaylistName('Bubble & Scrape'), 'bubble-and-scrape');
  assert.equal(slug.slugifyPlaylistName('Café  Mixtape'), 'cafe-mixtape');
});

test('a playlist whose name makes no address at all still gets one', () => {
  assert.equal(slug.slugifyPlaylistName('!!!'), 'playlist');
  assert.equal(slug.slugifyPlaylistName(''), 'playlist');
  assert.equal(slug.slugifyPlaylistName('ok'), 'playlist', 'two letters is under the minimum');
});

test('a generated address is never longer than the column allows', () => {
  assert.ok(slug.slugifyPlaylistName('a very '.repeat(40)).length <= slug.PLAYLIST_SLUG_MAX);
});

test('a typed playlist address may carry its own /p/ prefix', () => {
  assert.deepStrictEqual(slug.normalizePlaylistSlug('p/my-mix'), { ok: true, slug: 'my-mix' });
  assert.deepStrictEqual(slug.normalizePlaylistSlug('  /My Mix/ '), { ok: true, slug: 'my-mix' });
});

test('a playlist address may not shadow a page the app already owns', () => {
  // Deliberately the same reserved list the Online Jukebox rooms use, so the
  // two cannot drift apart and start disagreeing about what is free.
  const res = slug.normalizePlaylistSlug('help');
  assert.equal(res.ok, false);
  assert.match(res.message, /page on this site already/);
  assert.ok(jb.RESERVED_SLUGS.has('help'));
});

test('a playlist address that is too short or not text is refused with a reason', () => {
  assert.equal(slug.normalizePlaylistSlug('ab').ok, false);
  assert.equal(slug.normalizePlaylistSlug(null).ok, false);
  assert.match(slug.normalizePlaylistSlug('--').message, /at least 3/);
});

// ── Storage allowance ─────────────────────────────────────────────────────

test('audio storage is 500 MB for everyone while the site is being built out', () => {
  const MB = 1024 * 1024;
  assert.equal(levels.USER_STORAGE_LIMITS.free, 500 * MB);
  assert.equal(levels.USER_STORAGE_LIMITS.standard, 500 * MB);
  assert.equal(levels.USER_STORAGE_LIMITS.premium, 500 * MB);
});

test('admin keeps its ceiling because it is staff tooling, not a product tier', () => {
  assert.equal(levels.USER_STORAGE_LIMITS.admin, 10 * 1024 * 1024 * 1024);
});

test('the level ladder still exists, so restoring tiers is a change to numbers', () => {
  assert.deepStrictEqual(levels.USER_LEVELS, ['free', 'standard', 'premium', 'admin']);
});

test('an unrecognised level is null rather than quietly becoming a real one', () => {
  assert.equal(levels.normalizeUserLevel('PREMIUM'), 'premium');
  assert.equal(levels.normalizeUserLevel('  admin '), 'admin');
  assert.equal(levels.normalizeUserLevel('superuser'), null);
  assert.equal(levels.normalizeUserLevel(undefined), null);
});

test('the published promise on /help matches the number in the code', () => {
  // /help#how is where this is promised to users. If the allowance moves, the
  // page has to move with it, so the two are checked against each other.
  const promised = levels.USER_STORAGE_LIMITS.free / (1024 * 1024);
  assert.match(
    readRepoFile('public/help/index.html'),
    new RegExp(promised + '\\s*MB'),
    '/help no longer states the allowance the code actually gives',
  );
});
