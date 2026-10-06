// @suite Artist stats access
// @area Platform
// @covers src/lib/artist-manage.ts, src/app/api/artist-stats/route.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

function fixture() {
  const own = { id: 'own', name: 'Own Music', slug: 'own-music', artist_upload_created_by: 'artist-user' };
  const other = { id: 'other', name: 'Other Music', slug: 'other-music', added_by: 'importer@example.test' };
  const granted = { id: 'grant', name: 'Granted Music', slug: 'granted-music' };
  const approved = { id: 'approved', name: 'Approved Music', slug: 'approved-music' };
  const pending = { id: 'pending', name: 'Pending Music', slug: 'pending-music' };
  const rows = {
    artists: [own, other, granted, approved, pending],
    content_access: [{ artist_id: 'other', user_email: 'importer@example.test' }],
    artist_upload_grants: [{ artist_id: 'grant', user_email: 'artist@example.test' }],
    artist_rights_agreements: [
      { artist_id: 'approved', user_id: 'artist-user', status: 'approved' },
      { artist_id: 'pending', user_id: 'artist-user', status: 'pending' },
    ],
  };
  const rpcCalls = [];
  const db = {
    from(table) {
      let result = [...(rows[table] || [])], fields = '*', one = false;
      const q = {
        select(value) { fields = value; return q; },
        eq(key, value) { result = result.filter(row => row[key] === value); return q; },
        in(key, values) { result = result.filter(row => values.includes(row[key])); return q; },
        order(key) { result.sort((a, b) => String(a[key]).localeCompare(String(b[key]))); return q; },
        range(from, to) { result = result.slice(from, to + 1); return q; },
        maybeSingle() { one = true; return q; },
        then(resolve) {
          const projected = result.map(row => fields === '*' ? row : Object.fromEntries(fields.split(',').map(key => [key.trim(), row[key.trim()]])));
          return Promise.resolve({ data: one ? projected[0] || null : projected, error: null }).then(resolve);
        },
      };
      return q;
    },
    rpc(name, args) { rpcCalls.push({ name, args }); return Promise.resolve({ data: { totals: { plays: 42 }, moments: [], referrers: [] }, error: null }); },
  };
  const sb = { schema: () => db };
  const auth = { JUKEBOX_SCHEMA: 'jukebox', createSjServiceClient: () => sb, isSjAdmin: async email => email === 'admin@example.test' };
  const manage = loadTs('src/lib/artist-manage.ts', { 'sj-admin-auth': auth });
  return { sb, auth, manage, rpcCalls };
}
const artist = { id: 'artist-user', email: 'artist@example.test' };
const importer = { id: 'importer-user', email: 'importer@example.test' };
const admin = { id: 'admin-user', email: 'admin@example.test' };

test('community import/edit access does not grant private metrics', async () => {
  const { sb, manage } = fixture();
  assert.equal(await manage.canManageArtist(sb, importer.email, 'other'), true);
  assert.equal(await manage.canViewArtistStats(sb, importer, 'other'), false);
  assert.deepEqual(await manage.listStatsArtists(sb, importer), []);
});
test('artist sees only directly uploaded, granted, or approved music', async () => {
  const { sb, manage } = fixture();
  assert.deepEqual((await manage.listStatsArtists(sb, artist)).map(a => a.id).sort(), ['approved', 'grant', 'own']);
  for (const id of ['approved', 'grant', 'own']) assert.equal(await manage.canViewArtistStats(sb, artist, id), true);
  for (const id of ['other', 'pending']) assert.equal(await manage.canViewArtistStats(sb, artist, id), false);
  assert.deepEqual(await manage.listStatsArtists(sb, { id: 'listener-user', email: 'listener@example.test' }), []);
});
test('admin may select every artist and open any artist metrics', async () => {
  const { sb, manage } = fixture();
  assert.equal((await manage.listStatsArtists(sb, admin)).length, 5);
  assert.equal(await manage.canViewArtistStats(sb, admin, 'other'), true);
});
test('API rejects anonymous and other-artist requests before running metrics', async () => {
  const { auth, manage, rpcCalls } = fixture();
  let user = null;
  const route = loadTs('src/app/api/artist-stats/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    'sj-admin-auth': { ...auth, getAuthUser: async () => user },
    'artist-manage': manage,
    'artist-stats': { lyricAt: () => null, groupReferrers: rows => rows },
  });
  const get = query => route.GET({ nextUrl: new URL(`https://example.test/api/artist-stats${query}`) });
  assert.equal((await get('?artist=other-music')).status, 401);
  user = artist;
  const forbidden = await get('?artist=other-music');
  assert.equal(forbidden.status, 403);
  assert.equal(rpcCalls.length, 0);
  assert(!JSON.stringify(await forbidden.json()).includes('Other Music'));
  const allowed = await get('?artist=own-music');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await allowed.json()).isAdmin, false);
  assert.equal(rpcCalls[0].args.p_artist_id, 'own');
  user = admin;
  const global = await get('?artist=other-music');
  assert.equal(global.status, 200);
  assert.equal((await global.json()).isAdmin, true);
  assert.equal(rpcCalls[1].args.p_artist_id, 'other');
});
