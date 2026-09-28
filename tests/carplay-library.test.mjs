// @suite CarPlay streaming library
// @area CarPlay
// @covers /api/sj-carplay-library: what the car can stream without a download
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

const ARTIST_SONG = '251afba8-68d5-481a-b5de-d93366ad6b6b';
const MY_SONG = 'f124981d-355e-45a4-8b71-b5cb654e498d';
const ME = '11111111-1111-1111-1111-111111111111';

function library({ user = null, sign = async (key) => 'https://b2.example/' + key, visible = true } = {}) {
  const tables = {
    artist_catalog_tracks: [{ agreement_id: 'agreement', track_audio_id: 'artist-audio', track_id: ARTIST_SONG,
      artist_id: 'artist', approved_at: '2026-09-20' }],
    artist_rights_agreements: [{ id: 'agreement', agreement_version: 'current' }],
    track_audio: [
      { id: 'artist-audio', track_id: ARTIST_SONG, storage_path: 'artist/song.wav', duration_seconds: 143 },
      { id: 'mine', track_id: MY_SONG, storage_path: `${ME}/${MY_SONG}/a.mp3`, duration_seconds: 200 },
    ],
    tracks: [
      { id: ARTIST_SONG, name: 'Marshmallow Choke', album_id: 'vw', duration_ms: null,
        artist_audio_only: true, artist_audio_visible: visible },
      { id: MY_SONG, name: 'My Upload', album_id: 'mine', duration_ms: 1000 },
    ],
    albums: [
      { id: 'vw', name: 'Victim Weight', artist_id: 'artist', art_url: '/album-art/vw', artist_audio_visible: true },
      { id: 'mine', name: 'Mine', artist_id: 'me', art_url: 'https://i.ytimg.com/x.jpg' },
    ],
    artists: [{ id: 'artist', name: 'Victim Weight' }, { id: 'me', name: 'Johnny Outlaw' }],
  };
  // Chains resolve to the table, narrowed by the one filter each read in the
  // route depends on: whose uploads, or which ids.
  const query = (table) => {
    let rows = tables[table];
    const q = { then: (ok, fail) => Promise.resolve({ data: rows, error: null }).then(ok, fail) };
    q.select = q.order = q.not = q.limit = () => q;
    q.eq = (col, val) => { if (col === 'uploaded_by') rows = val === ME ? rows.filter((r) => r.id === 'mine') : []; return q; };
    q.in = (col, vals) => { rows = rows.filter((r) => vals.includes(r[col === 'id' ? 'id' : col])); return q; };
    return q;
  };
  const sb = { schema: () => ({ from: query }) };
  const eligibility = loadTs('src/lib/bg-audio-eligibility.ts', { 'sj-admin-auth': { JUKEBOX_SCHEMA: 'jukebox' } });
  const route = loadTs('src/app/api/sj-carplay-library/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => ({ body, ...init }) } },
    'sj-admin-auth': { JUKEBOX_SCHEMA: 'jukebox', createSjServiceClient: () => sb, getAuthUser: async () => user },
    'artist-rights': { ARTIST_AGREEMENT_VERSION: 'current' },
    'bg-audio-eligibility': eligibility,
    'b2-audio': {
      createB2DownloadUrl: sign,
      sisterB2RedirectUrl: () => null,
      isOwnedAudioKey: (path, userId, trackId) => path.startsWith(`${userId}/${trackId}/`),
    },
    surface: { SURFACES: { sj: { url: 'https://www.sufferingjukebox.stream' } } },
  });
  return route.GET({ nextUrl: new URL('https://www.sufferingjukebox.stream/api/sj-carplay-library') });
}

test('signed out, the car gets the public artist songs with absolute covers', async () => {
  const r = await library();
  assert.equal(r.body.ok, true);
  assert.equal(r.body.signedIn, false);
  assert.deepEqual(r.body.tracks.map((t) => [t.trackId, t.source]), [[ARTIST_SONG, 'artist']]);
  assert.equal(r.body.tracks[0].artworkUrl, 'https://www.sufferingjukebox.stream/album-art/vw');
  assert.equal(r.body.tracks[0].artist, 'Victim Weight');
  assert.match(r.headers['Cache-Control'], /no-store/);
});

test('signed in, your own uploads join the artist songs', async () => {
  const r = await library({ user: { id: ME } });
  assert.equal(r.body.signedIn, true);
  const mine = r.body.tracks.find((t) => t.trackId === MY_SONG);
  assert.equal(mine.source, 'personal');
  assert.equal(mine.url, `https://b2.example/${ME}/${MY_SONG}/a.mp3`);
  assert.equal(r.body.tracks.length, 2);
});

test('URLs outlast a week of drives between app opens', async () => {
  let expiry;
  const r = await library({ sign: async (key, seconds) => { expiry = seconds; return 'https://b2.example/' + key; } });
  assert.equal(expiry, 7 * 24 * 60 * 60);
  assert.ok(r.body.expiresAt > Date.now() / 1000 + 6.9 * 24 * 60 * 60);
});

test('an unpublished artist song never reaches the car', async () => {
  const r = await library({ visible: false });
  assert.deepEqual(r.body.tracks, []);
});

test('storage failing outright is an error, not an empty list that wipes the car', async () => {
  const r = await library({ sign: async () => { throw new Error('B2 down'); } });
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
});
