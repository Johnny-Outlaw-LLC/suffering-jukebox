// @suite Playlist audio playback
// @area Playback
// @covers mixed video and audio-only playlists, background shuffle and native handoff
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

const queueScope = () => ({
  taTrackAudio: id => id === 'personal' ? { url: 'personal-audio' } : null,
  ytQueueItem: (videoId, title, trackId) => ({ videoId, title, trackId }),
});

test('playlist queues retain artist recordings and personal uploads without YouTube IDs', () => {
  const { playlistQueueItem } = loadHtmlFnsInScope(['playlistQueueItem'], queueScope());
  assert.deepEqual(playlistQueueItem('nouns', { name: 'Adjustments', artistAudio: true }),
    { videoId: null, title: 'Adjustments', trackId: 'nouns', artistAudio: true });
  assert.equal(playlistQueueItem('personal', { name: 'My upload' }).artistAudio, true);
  assert.equal(playlistQueueItem('video', { name: 'Video', videoId: 'yt' }).videoId, 'yt');
  assert.equal(playlistQueueItem('missing', { name: 'No media' }), null);
  assert.equal(playlistQueueItem('missing', undefined), null);
});

test('playlist resolution preserves the database audio-only flag for an unvisited artist', async () => {
  const scope = {
    dbGet: async path => path.startsWith('/tracks')
      ? [{ id: 'nouns', name: 'Adjustments', album_id: 'album', artist_audio_only: true }]
      : path.startsWith('/albums') ? [{ id: 'album', name: 'Record', artist_id: 'artist' }]
      : [{ id: 'artist', name: 'Nouns Group' }],
    loadYTVideoIds: async () => ({}), SJ_TRACK_META: {}, ALBUM_ART: {},
  };
  const { resolvePlaylistTracks } = loadHtmlFnsInScope(['resolvePlaylistTracks'], scope);
  const info = await resolvePlaylistTracks(['nouns']);
  assert.equal(info.nouns.artistAudio, true);
  assert.equal(info.nouns.videoId, null);
  assert.equal(scope.SJ_TRACK_META.nouns.artist, 'Nouns Group');
});

test('Background Enabled playlist shuffle plays audio-only songs instead of the empty warning', async () => {
  const played = [], alerts = [];
  const scope = {
    ...queueScope(), document: { getElementById: () => null }, _homeLibLoaded: true,
    homeJukeboxBgFilterOn: () => true, playlistExploreTrackIds: () => ['nouns', 'youtube-only'],
    resolvePlaylistTracks: async () => ({ nouns: { name: 'Adjustments', artistAudio: true },
      'youtube-only': { name: 'Video', videoId: 'yt' } }),
    isTrackSkipped: () => false, filterQueueForHomeBg: q => q.filter(it => it.trackId === 'nouns'),
    landingPlayQueue: async (q, opts) => played.push({ q, opts }),
    loadTrackAudio: async () => {}, taSyncAudioBtn() {}, alert: msg => alerts.push(msg), console,
  };
  const { playlistsShuffleAll } = loadHtmlFnsInScope(['playlistQueueItem', 'playlistsShuffleAll'], scope);
  await playlistsShuffleAll();
  assert.deepEqual(alerts, []);
  assert.deepEqual(played[0].q.map(it => it.trackId), ['nouns']);
  assert.equal(played[0].q[0].artistAudio, true);
  assert.equal(played[0].opts.shuffle, true);
});

test('ordinary native playlist playback primes audio and hands the complete queue to AVPlayer', async () => {
  const calls = [];
  const scope = {
    _taPreferBg: true, ytPlayerEl: null, ytQueue: [], ytQueueIdx: -1,
    homeJukeboxBgFilterOn: () => false, taIsMobileDevice: () => true, taNativeBgPlugin: () => ({}),
    filterQueueForHomeBg: q => q, sjNoBlocked: q => q, clearQueueSourcePlaylist() {},
    taSetPreferBg() {}, loadTrackAudio: async ids => calls.push(['prime', ids]),
    openYTPlayer: () => calls.push(['open']), ytpIsArtistAudio: it => !!it.artistAudio,
    ytPlayQueueIdx: idx => calls.push(['audio', idx]), updateYTQueueUI() {},
    taTryStartPreferredBg: () => calls.push(['native', scope.ytQueue.map(it => it.trackId)]),
  };
  const { landingPlayQueue } = loadHtmlFnsInScope(['landingPlayQueue'], scope);
  await landingPlayQueue([{ trackId: 'nouns', artistAudio: true }, { trackId: 'second', artistAudio: true }]);
  assert.deepEqual(calls, [['prime', ['nouns']], ['open'], ['audio', 0], ['native', ['nouns', 'second']]]);
});

test('an unvisited audio-only playlist track retains its Play eligibility in Details', () => {
  const scope = { tracks: {}, playlistChartRows: [{ trackId: 'nouns', title: 'Adjustments', artistAudio: true }] };
  const { findTrackById } = loadHtmlFnsInScope(['findTrackById'], scope);
  assert.equal(findTrackById('nouns').artist_audio_only, true);
});

test('an audio-only song can be pinned to Play Next through its song menu', async () => {
  const scope = {
    ...queueScope(), _sjmTrackId: 'nouns', sjmClose() {}, showToast() {},
    resolvePlaylistTracks: async () => ({ nouns: { name: 'Adjustments', artistAudio: true } }),
    ytPlayerEl: {}, ytQueue: [{ trackId: 'current' }], ytQueueIdx: 0, _queueHasAdditions: false,
    ytResetShufflePool() {}, ytMoveAfterCurrent: idx => idx,
    ytSetPlayNext: item => { scope.pinned = item; }, ytpPaintUpNext() {},
  };
  const { sjmPlayNext } = loadHtmlFnsInScope(['playlistQueueItem', 'sjmPlayNext'], scope);
  await sjmPlayNext();
  assert.equal(scope.ytQueue[1].trackId, 'nouns');
  assert.equal(scope.pinned.artistAudio, true);
});
