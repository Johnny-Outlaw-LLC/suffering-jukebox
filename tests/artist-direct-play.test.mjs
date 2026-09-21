// @suite Artist direct playback
// @area Playback
// @covers Artist Play buttons, authorized streaming, and Listening Party art
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, loadTs, dashboardHtml } from './_load.mjs';

const awsStubs = {
  '@aws-sdk/client-s3': {
    DeleteObjectCommand: class {}, GetObjectCommand: class {},
    HeadObjectCommand: class {}, PutObjectCommand: class {}, S3Client: class {},
  },
  '@aws-sdk/s3-request-presigner': { getSignedUrl: async () => '' },
  surface: {
    currentSurface: (host) => ({ id: String(host || '').includes('listeningparty') ? 'lp' : 'sj' }),
    SURFACES: { sj: { url: 'https://www.sufferingjukebox.stream' } },
  },
};

function withNoB2(fn) {
  const prev = { B2_KEY_ID: process.env.B2_KEY_ID, B2_APP_KEY: process.env.B2_APP_KEY };
  delete process.env.B2_KEY_ID;
  delete process.env.B2_APP_KEY;
  try { return fn(); }
  finally {
    if (prev.B2_KEY_ID) process.env.B2_KEY_ID = prev.B2_KEY_ID; else delete process.env.B2_KEY_ID;
    if (prev.B2_APP_KEY) process.env.B2_APP_KEY = prev.B2_APP_KEY; else delete process.env.B2_APP_KEY;
  }
}

test('Listening Party without B2 keys sends covers to the shared signer', () => {
  withNoB2(() => {
    const { sisterB2RedirectUrl } = loadTs('src/lib/b2-audio.ts', awsStubs);
    assert.equal(
      sisterB2RedirectUrl('listeningparty.stream', '/artist-release-art/abc'),
      'https://www.sufferingjukebox.stream/artist-release-art/abc',
    );
    assert.equal(sisterB2RedirectUrl('www.sufferingjukebox.stream', '/artist-release-art/abc'), null);
  });
});

test('a surface that can sign does not bounce artwork away', () => {
  const prev = { B2_KEY_ID: process.env.B2_KEY_ID, B2_APP_KEY: process.env.B2_APP_KEY };
  process.env.B2_KEY_ID = 'id';
  process.env.B2_APP_KEY = 'key';
  try {
    const { sisterB2RedirectUrl } = loadTs('src/lib/b2-audio.ts', awsStubs);
    assert.equal(sisterB2RedirectUrl('listeningparty.stream', '/album-art/abc'), null);
  } finally {
    if (prev.B2_KEY_ID) process.env.B2_KEY_ID = prev.B2_KEY_ID; else delete process.env.B2_KEY_ID;
    if (prev.B2_APP_KEY) process.env.B2_APP_KEY = prev.B2_APP_KEY; else delete process.env.B2_APP_KEY;
  }
});

for (const [name, count] of [['Victim Weight', 1], ['Nouns Group', 7]]) {
  test(`${name}: artist Play queues uploads even without YouTube IDs`, async () => {
    let played;
    const songs = Array.from({ length: count }, (_, i) => ({
      id: `t${i}`, name: `Song ${i}`, album_id: 'album', artist_audio_only: true,
    }));
    const scope = {
      landingStats: [{ artist_id: 'artist', name }],
      document: { querySelector: () => null },
      homeJukeboxBgFilterOn: () => false,
      laEnsureArtistData: async () => ['artist'],
      albums: { artist: [{ id: 'album', name: 'Release' }] },
      tracks: { artist: songs },
      ytData: {},
      ytPlayerEl: null,
      filterTracksForHomeBg: (rows) => rows,
      shuffleInPlace: (rows) => rows,
      sjUnlockAudioEl: () => {},
      loadArtistOnDemandAudio: async () => {},
      loadTrackAudio: async () => {},
      sjArtistQueueItem: (t) => ({ trackId: t.id, title: t.name, artistAudio: true }),
      landingPlayQueue: (rows) => { played = rows; },
      taSyncAudioBtn: () => {},
    };
    await loadHtmlFnsInScope(['landingPlayArtist'], scope).landingPlayArtist('artist');
    assert.equal(played.length, count);
    assert.ok(played.every((row) => row.artistAudio));
  });
}

test('YouTube artist playback continues through the original queue', async () => {
  let played;
  const scope = {
    landingStats: [{ artist_id: 'artist', name: 'Band' }],
    document: { querySelector: () => null },
    homeJukeboxBgFilterOn: () => false,
    laEnsureArtistData: async () => ['artist'],
    albums: { artist: [{ id: 'album', name: 'Release' }] },
    tracks: { artist: [{ id: 't', name: 'Song', album_id: 'album' }] },
    ytData: { t: { video_id: 'video' } },
    ytPlayerEl: null,
    filterTracksForHomeBg: (rows) => rows,
    shuffleInPlace: (rows) => rows,
    loadTrackAudio: async () => {},
    landingPlayQueue: (rows) => { played = rows; },
    taSyncAudioBtn: () => {},
  };
  await loadHtmlFnsInScope(['landingPlayArtist'], scope).landingPlayArtist('artist');
  assert.deepEqual(played, [{ videoId: 'video', title: 'Song', trackId: 't' }]);
});

test('clicking an individual artist song starts there, with its album in order', async () => {
  let played;
  const songs = [{id:'second', album_id:'a', track_number:2, artist_audio_only:true}, {id:'first', album_id:'a', track_number:1, artist_audio_only:true}];
  const scope = { tracks: { artist: songs }, sjUnlockAudioEl: () => {}, sjArtistPlayRows: (rows, id) => { played = { rows, id }; } };
  await loadHtmlFnsInScope(['sjArtistPlayTrack'], scope).sjArtistPlayTrack('second');
  assert.deepEqual(played.rows.map(t => t.id), ['first','second']);
  assert.equal(played.id, 'second');
});

test('the docked player, not a native audio bar, is what artist uploads open', () => {
  assert.match(dashboardHtml, /function ytpShowArtFrame\(/);
  assert.match(dashboardHtml, /function ytpStartArtistAudio\(/);
  assert.match(dashboardHtml, /sjPlayArtistQueue\(items, startId\)/);
  assert.doesNotMatch(dashboardHtml, /id = 'sj-artist-audio'/);
  assert.doesNotMatch(dashboardHtml, /#sj-artist-player/);
});

const id = '251afba8-68d5-481a-b5de-d93366ad6b6b';
function signer({ visible = true, approved = true, surface = 'sj' } = {}) {
  const tables = { tracks: [{id, album_id:'album', artist_audio_only:true, artist_audio_visible:visible}],
    albums: [{id:'album',artist_audio_visible:true}], track_audio:[{id:'audio',storage_path:'private/song.wav'}], artists:[{id:'artist',name:'Victim Weight'}] };
  let signed = 0;
  const route = loadTs('src/app/api/sj-artist-audio/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => ({body,...init}), redirect: (url, init) => ({url,...init}) } },
    'sj-admin-auth': { JUKEBOX_SCHEMA: 'jukebox', createSjServiceClient: () => ({ schema: () => ({ from: table => ({select: () => ({in: async () => ({ data:tables[table],error:null })})}) }) }) },
    'artist-rights': { ARTIST_AGREEMENT_VERSION:'current', isUuid: value => /^[\da-f-]{36}$/.test(value) },
    'bg-audio-eligibility': { approvedArtistAudioTracks: async () => approved ? [{track_id:id,track_audio_id:'audio',artist_id:'artist'}] : [] },
    'b2-audio': {
      createB2DownloadUrl: async () => { signed++; return 'https://audio.example/signed'; },
      sisterB2RedirectUrl: (host, pathAndQuery) => surface === 'lp'
        ? new URL(pathAndQuery, 'https://www.sufferingjukebox.stream').toString()
        : null,
    },
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

for (const format of ['', '&format=stream']) {
  test(`Listening Party without B2 keys uses the shared authorized signer ${format}`, async () => {
    const api = signer({surface:'lp'});
    const r = await api.get(`purpose=normal-playback&track_ids=${id}${format}`);
    assert.equal(r.status,307);
    assert.equal(r.url.origin,'https://www.sufferingjukebox.stream');
    assert.equal(r.url.pathname,'/api/sj-artist-audio');
    assert.equal(r.url.searchParams.get('purpose'),'normal-playback');
    assert.equal(r.url.searchParams.get('track_ids'),id);
    assert.equal(r.url.searchParams.get('format'),format ? 'stream' : null);
    assert.equal(api.signed(),0);
  });
}
