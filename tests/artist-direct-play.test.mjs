// @suite Artist direct playback
// @area Playback
// @covers Artist Play buttons and authorized streaming
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, loadTs, dashboardHtml } from './_load.mjs';

for (const [name, count] of [['Victim Weight', 1], ['Nouns Group', 7]]) {
  test(`${name}: artist Play queues uploads even without YouTube IDs`, async () => {
    let played;
    const songs = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: `Song ${i}`, album_id: 'album', artist_audio_only: true }));
    const scope = { landingStats: [{ artist_id: 'artist', name }],
      document: { querySelector: () => null }, sjArtistPrime: () => {},
      homeJukeboxBgFilterOn: () => false, laEnsureArtistData: async () => ['artist'],
      albums: { artist: [{ id: 'album', name: 'Release' }] }, tracks: { artist: songs }, ytData: {},
      filterTracksForHomeBg: rows => rows, sjArtistPlayRows: rows => { played = rows; },
    };
    await loadHtmlFnsInScope(['landingPlayArtist'], scope).landingPlayArtist('artist');
    assert.deepEqual(played, songs);
  });
}
test('YouTube artist playback continues through the original queue', async () => {
  let played;
  const scope = { landingStats: [{ artist_id: 'artist', name: 'Band' }],
    document: { querySelector: () => null }, sjArtistPrime: () => {},
    homeJukeboxBgFilterOn: () => false, laEnsureArtistData: async () => ['artist'],
    albums: { artist: [{ id: 'album', name: 'Release' }] }, tracks: { artist: [{ id: 't', name: 'Song', album_id: 'album' }] },
    ytData: { t: { video_id: 'video' } }, filterTracksForHomeBg: rows => rows,
    shuffleInPlace: rows => rows, loadTrackAudio: async () => {}, ytPlayerEl: null,
    landingPlayQueue: rows => { played = rows; }, taSyncAudioBtn: () => {},
  };
  await loadHtmlFnsInScope(['landingPlayArtist'], scope).landingPlayArtist('artist');
  assert.deepEqual(played, [{ videoId: 'video', title: 'Song', trackId: 't' }]);
});

test('clicking an individual artist song starts there, with its album in order', async () => {
  let played;
  const songs = [{id:'second', album_id:'a', track_number:2, artist_audio_only:true}, {id:'first', album_id:'a', track_number:1, artist_audio_only:true}];
  const scope = { tracks: { artist: songs }, sjArtistPrime: () => {}, sjArtistPlayRows: (rows, id) => { played = { rows, id }; } };
  await loadHtmlFnsInScope(['sjArtistPlayTrack'], scope).sjArtistPlayTrack('second');
  assert.deepEqual(played.rows.map(t => t.id), ['first','second']);
  assert.equal(played.id, 'second');
});

const id = '251afba8-68d5-481a-b5de-d93366ad6b6b';
function signer({ visible = true, approved = true } = {}) {
  const tables = { tracks: [{id, album_id:'album', artist_audio_only:true, artist_audio_visible:visible}],
    albums: [{id:'album',artist_audio_visible:true}], track_audio:[{id:'audio',storage_path:'private/song.wav'}], artists:[{id:'artist',name:'Victim Weight'}] };
  let signed = 0;
  const route = loadTs('src/app/api/sj-artist-audio/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => ({body,...init}), redirect: (url, init) => ({url,...init}) } },
    'sj-admin-auth': { JUKEBOX_SCHEMA: 'jukebox', createSjServiceClient: () => ({ schema: () => ({ from: table => ({select: () => ({in: async () => ({ data:tables[table],error:null })})}) }) }) },
    'artist-rights': { ARTIST_AGREEMENT_VERSION:'current', isUuid: value => /^[\da-f-]{36}$/.test(value) },
    'bg-audio-eligibility': { approvedArtistAudioTracks: async () => approved ? [{track_id:id,track_audio_id:'audio',artist_id:'artist'}] : [] },
    'b2-audio': { createB2DownloadUrl: async () => { signed++; return 'https://audio.example/signed'; } },
  });
  return { get: query => route.GET({nextUrl:new URL('https://listeningparty.stream/api/sj-artist-audio?'+query)}), signed: () => signed };
}
test('streaming redirects to approved audio without caching the expiring URL', async () => {
  const api = signer(); const r = await api.get(`purpose=normal-playback&format=stream&track_ids=${id}`);
  assert.equal(r.status,307); assert.equal(r.url,'https://audio.example/signed');
  assert.match(r.headers['Cache-Control'], /no-store/);
});
for (const options of [{visible:false}, {approved:false}]) {
  test(`streaming cannot bypass publication/approval: ${JSON.stringify(options)}`, async () => {
    const api = signer(options); const r = await api.get(`purpose=normal-playback&format=stream&track_ids=${id}`);
    assert.equal(api.signed(),0); assert.equal(r.url,undefined);
  });
}
test('background-only authorization cannot be used for a normal stream', async () => {
  const api = signer(); const r = await api.get(`purpose=mobile-background&format=stream&track_ids=${id}`);
  assert.equal(r.status,400); assert.equal(api.signed(),0);
});
test('existing JSON clients still receive signed track objects', async () => {
  const api = signer(); const r = await api.get(`purpose=normal-playback&track_ids=${id}`);
  assert.equal(r.body.tracks[0].trackId,id); assert.equal(r.url,undefined);
});

test('Explore Songs plays the selected upload rather than the next YouTube song', async () => {
  let played;
  const scope = { findTrackById: () => ({artist_audio_only:true}), sjArtistPlayTrack: id => { played=id; } };
  await loadHtmlFnsInScope(['esRowPlay'], scope).esRowPlay('artist-song');
  assert.equal(played,'artist-song');
});
