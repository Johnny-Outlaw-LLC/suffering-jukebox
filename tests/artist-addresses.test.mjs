// @suite Artist addresses
// @area Navigation
// @covers /<artist-slug> on both brands, sharing Listening Party's root with playlists
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, readRepoFile, dashboardHtml } from './_load.mjs';

const proxy = loadTs('src/proxy.ts', {
  'next/server': { NextResponse: {} },
  '@/lib/jukebox': { RESERVED_SLUGS: new Set() },
  '@/lib/surface': { currentSurface: () => ({ id: 'lp' }) },
});
const slugs = { playlists: new Set(['road-trip', 'shared-name']), artists: new Set(['nouns-group', 'shared-name']) };

test('a Listening Party artist slug goes to the artist page', () => {
  assert.equal(proxy.lpRootTarget('nouns-group', slugs), 'artist');
});
test('a playlist keeps its root address, even if an artist later takes the name', () => {
  assert.equal(proxy.lpRootTarget('road-trip', slugs), 'playlist');
  assert.equal(proxy.lpRootTarget('shared-name', slugs), 'playlist');
});
test('when the slug lists cannot be read, it falls back to the playlist route', () => {
  assert.equal(proxy.lpRootTarget('nouns-group', null), 'playlist');
});
test('both brands give artists an address, and the route serves it', () => {
  const surface = readRepoFile('src/lib/surface.ts');
  assert.equal((surface.match(/artistAddresses: true,/g) || []).length, 2);
  assert.match(readRepoFile('src/app/[slug]/route.ts'), /if \(!surface\.features\.artistAddresses\) return/);
});
test('opening an artist pushes /<slug>, and Back on an unknown playlist slug tries the artist', () => {
  assert.match(dashboardHtml, /const url = SJ_BRAND\.features\.artistAddresses !== false \? '\/' \+ artist\.slug : '\/'/);
  assert.match(dashboardHtml, /if \(!p\) \{ popstateArtist\(playlistSlug\); return; \}/);
});
