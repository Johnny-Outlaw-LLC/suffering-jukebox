// @suite Artist audio health check
// @area Playback
// @covers The nightly check that every public artist upload plays on both brands
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, readRepoFile } from './_load.mjs';

const health = loadTs('src/lib/artist-audio-health.ts', { 'sj-admin-auth': { JUKEBOX_SCHEMA: 'jukebox' } });

// A Supabase client stub that answers .schema().from(t).select().eq()/.in().
function fakeDb(tables) {
  const query = (rows) => {
    let out = rows;
    const q = {
      select: () => q,
      eq: (k, v) => { out = out.filter(r => r[k] === v); return q; },
      in: (k, vs) => { out = out.filter(r => vs.includes(r[k])); return q; },
      then: (res, rej) => Promise.resolve({ data: out, error: null }).then(res, rej),
    };
    return q;
  };
  return { schema: () => ({ from: t => query(tables[t] || []) }) };
}

const SJ = 'https://www.sufferingjukebox.stream';
const LP = 'https://listeningparty.stream';

function audioFetch(failFor = () => null) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const bad = failFor(url);
    if (bad === 'throw') throw new Error('network down');
    if (bad) return { status: bad, headers: new Map([['content-type', 'application/json']]), arrayBuffer: async () => new ArrayBuffer(10) };
    return { status: 206, headers: new Map([['content-type', 'audio/mp4']]), arrayBuffer: async () => new ArrayBuffer(2) };
  };
  fn.calls = calls;
  return fn;
}

test('lists only songs the public catalogue shows as artist uploads', async () => {
  const db = fakeDb({
    tracks: [
      { id: 't1', name: 'Adjustments', album_id: 'a1', artist_audio_only: true, artist_audio_visible: true, visibility: 'public' },
      { id: 't2', name: 'Hidden track', album_id: 'a1', artist_audio_only: true, artist_audio_visible: false, visibility: 'public' },
      { id: 't3', name: 'Private album song', album_id: 'a2', artist_audio_only: true, artist_audio_visible: true, visibility: 'public' },
      { id: 't4', name: 'Private artist song', album_id: 'a3', artist_audio_only: true, artist_audio_visible: true, visibility: 'public' },
      { id: 't5', name: 'YouTube song', album_id: 'a1', artist_audio_only: false, artist_audio_visible: true, visibility: 'public' },
    ],
    albums: [
      { id: 'a1', artist_id: 'r1', visibility: 'public', artist_audio_visible: true },
      { id: 'a2', artist_id: 'r1', visibility: 'private', artist_audio_visible: true },
      { id: 'a3', artist_id: 'r2', visibility: 'public', artist_audio_visible: true },
    ],
    artists: [
      { id: 'r1', name: 'Nouns Group', visibility: 'public', artist_audio_visible: true },
      { id: 'r2', name: 'Secret Band', visibility: 'private', artist_audio_visible: true },
    ],
  });
  const songs = await health.publicArtistAudioSongs(db);
  assert.deepEqual(songs.map(s => s.trackId), ['t1']);
  assert.equal(songs[0].artist, 'Nouns Group');
});

test('asks each site for the first bytes of each song, as an <audio> element would', async () => {
  const f = audioFetch();
  const songs = [{ trackId: 't1', track: 'A', artist: 'X' }, { trackId: 't2', track: 'B', artist: 'X' }];
  const report = await health.checkArtistAudio(songs, [SJ, LP], f);
  assert.equal(report.checks, 4);
  assert.deepEqual(report.failures, []);
  assert.equal(f.calls.length, 4);
  for (const c of f.calls) {
    assert.match(c.url, /\/api\/sj-artist-audio\?purpose=normal-playback&format=stream&track_ids=t[12]$/);
    assert.equal(c.init.headers.Range, 'bytes=0-1');
    assert.equal(c.init.redirect, 'follow');
  }
  assert.ok(f.calls.some(c => c.url.startsWith(LP)), 'Listening Party is checked too');
});

test('a refused, non-audio or unreachable song is reported with the site it failed on', async () => {
  const f = audioFetch(url => url.startsWith(LP) && url.endsWith('t1') ? 404
    : url.startsWith(SJ) && url.endsWith('t2') ? 'throw' : null);
  const songs = [{ trackId: 't1', track: 'A', artist: 'X' }, { trackId: 't2', track: 'B', artist: 'X' }];
  const report = await health.checkArtistAudio(songs, [SJ, LP], f);
  const got = report.failures.map(x => `${x.host}|${x.trackId}`).sort();
  assert.deepEqual(got, [`${LP}|t1`, `${SJ}|t2`]);
  assert.match(report.failures.find(x => x.trackId === 't1').reason, /404/);
});

test('a 200 that is not audio counts as a failure', async () => {
  const f = async () => ({ status: 200, headers: new Map([['content-type', 'application/json']]), arrayBuffer: async () => new ArrayBuffer(20) });
  const report = await health.checkArtistAudio([{ trackId: 't1', track: 'A', artist: 'X' }], [SJ], f);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0].reason, /not audio/);
});

test('the alert email names the artist, song, site and problem, escaped', () => {
  const html = health.artistAudioAlertHtml({ checkedAt: 'now', songs: 1, hosts: [SJ], checks: 1,
    failures: [{ trackId: 't', track: '<b>Song</b>', artist: 'Nouns Group', host: LP, status: 404, reason: 'answered 404' }] });
  assert.match(html, /Nouns Group/);
  assert.match(html, /listeningparty\.stream/);
  assert.match(html, /answered 404/);
  assert.ok(!html.includes('<b>Song</b>'));
});

test('the route checks both brands and is locked to cron or an admin', () => {
  const src = readRepoFile('src/app/api/sj-artist-audio-health/route.ts');
  assert.match(src, /\[SURFACES\.sj\.url, SURFACES\.lp\.url\]/);
  assert.match(src, /SJ_CRON_SECRET/);
  assert.match(src, /isSjAdmin/);
});
