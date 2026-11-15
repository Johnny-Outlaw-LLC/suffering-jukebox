// @suite Play when nothing is playing
// @area Playback
// @covers Play starts at once on an idle player; the native engine gets the whole queue
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

function playingScope(over) {
  return Object.assign({ ytPlayerEl: {}, ytQueue: [{ trackId: 'a' }], _sjCarFollow: null,
    _ytUserWantsPlay: true, _taBgActive: false, ytAPIPlayer: { getPlayerState: () => 1 } }, over);
}

for (const [label, over, expected] of [
  ['no player', { ytPlayerEl: null }, false],
  ['empty queue', { ytQueue: [] }, false],
  ['paused by the listener', { _ytUserWantsPlay: false, ytAPIPlayer: { getPlayerState: () => 2 } }, false],
  ['restored at launch, paused', { _ytUserWantsPlay: false, ytAPIPlayer: null }, false],
  ['last song ended', { ytAPIPlayer: { getPlayerState: () => 0 } }, false],
  ['playing on YouTube', {}, true],
  ['buffering after Play', { ytAPIPlayer: { getPlayerState: () => 3 } }, true],
  ['native engine paused', { _sjCarFollow: { playing: false }, _ytUserWantsPlay: false }, false],
  ['native engine playing', { _sjCarFollow: { playing: true }, _ytUserWantsPlay: false }, true],
]) test(`sjQueueIsPlaying: ${label}`, () => {
  const { sjQueueIsPlaying } = loadHtmlFnsInScope(['sjQueueIsPlaying'], playingScope(over));
  assert.equal(sjQueueIsPlaying(), expected);
});

test('artist Play on a paused player starts the whole discography, no popup', async () => {
  let played, popup = false;
  const scope = {
    landingStats: [{ artist_id: 'artist', name: 'Band' }],
    document: { querySelector: () => null },
    homeJukeboxBgFilterOn: () => false,
    laEnsureArtistData: async () => ['artist'],
    albums: { artist: [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }] },
    tracks: { artist: [{ id: 't1', name: 'S1', album_id: 'a1' }, { id: 't2', name: 'S2', album_id: 'a2' }] },
    ytData: { t1: { video_id: 'v1' }, t2: { video_id: 'v2' } },
    ytPlayerEl: {},
    sjQueueIsPlaying: () => false,
    filterTracksForHomeBg: rows => rows,
    shuffleInPlace: rows => rows,
    sjUnlockAudioEl() {}, loadTrackAudio: async () => {}, taSyncAudioBtn() {},
    showAlbumQueueChoice: () => { popup = true; },
    landingPlayQueue: rows => { played = rows; },
  };
  await loadHtmlFnsInScope(['landingPlayArtist'], scope).landingPlayArtist('artist');
  assert.equal(popup, false);
  assert.deepEqual(played.map(q => q.trackId), ['t1', 't2']);
});

test('Play Now keeps the full list after ytPlayNow installs its one-song queue', () => {
  const calls = [];
  const scope = { ytQueue: [], ytQueueIdx: -1,
    ytPlayNow(v, t, id) { calls.push('play:' + id); scope.ytQueue = [{ trackId: id }]; scope.ytQueueIdx = 0; },
    updateYTQueueUI() { calls.push('paint:' + scope.ytQueue.length); } };
  const { ytPlayQueueNow } = loadHtmlFnsInScope(['ytPlayQueueNow'], scope);
  ytPlayQueueNow([{ trackId: 'a' }, { trackId: 'b' }, { trackId: 'c' }]);
  assert.deepEqual(calls, ['play:a', 'paint:3']);
  assert.deepEqual(scope.ytQueue.map(q => q.trackId), ['a', 'b', 'c']);
});

test('the native engine receives a queue the page changed, once', async () => {
  const sent = [];
  const plugin = { setQueue: async payload => sent.push(payload), play: async () => {} };
  const scope = {
    SJ_BRAND: { id: 'rk' }, sjIsNative: () => true, sjDlPlugin: () => plugin, console,
    _taNativeBgActive: true, _sjCarFollow: null, _sjCarFollowDriving: false, _sjCarStandIn: false,
    _taNativeQueueSig: 'a', _sjCarQueueSnapshot: null,
    ytQueue: [{ trackId: 'a', title: 'A' }, { trackId: 'b', title: 'B' }], ytQueueIdx: 0,
    ytpTrackMeta: (id, title) => ({ title, artist: '', album: '', artwork: '' }),
    taTrackAudio: () => null,
  };
  const api = loadHtmlFnsInScope(['taNativeBgPlugin', 'taNativeQueuePayload', 'taNativeQueueSig', 'taNativeRememberQueue', 'taNativeSyncQueue'], scope);
  api.taNativeSyncQueue();
  api.taNativeSyncQueue();
  assert.equal(sent.length, 1, 'an unchanged queue is not sent again');
  assert.deepEqual(sent[0].tracks.map(t => t.id), ['a', 'b']);
  assert.equal(sent[0].startIndex, 0);
  assert.deepEqual(scope._sjCarQueueSnapshot.map(t => t.id), ['a', 'b']);

  // While the page shows its one-song stand-in for the song native is playing,
  // that list must not replace native's queue.
  scope.ytQueue = [{ trackId: 'a', title: 'A' }];
  scope._sjCarFollow = { trackId: 'a' };
  scope._sjCarStandIn = true;
  api.taNativeSyncQueue();
  assert.equal(sent.length, 1);
  scope._sjCarStandIn = false;
  scope._sjCarFollow = null;

  // The page loading the car's own song must not push its stand-in queue.
  scope.ytQueue = [{ trackId: 'z', title: 'Z' }];
  scope._sjCarFollowDriving = true;
  api.taNativeSyncQueue();
  assert.equal(sent.length, 1);

  // Nothing is handed over when the native engine is not in play.
  scope._sjCarFollowDriving = false;
  scope._taNativeBgActive = false;
  api.taNativeSyncQueue();
  assert.equal(sent.length, 1);
});

test('following native playback copies its whole queue back, not the stand-in', async () => {
  // Reproduces Play on an artist in the phone app: the page sent native ten
  // songs, so native's status ticks leave the queue out. The page must still
  // end up showing all ten, and must not send its one-song stand-in back.
  const sent = [];
  const native = { setQueue: async q => sent.push(q), play: async () => {}, getStatus: async () => ({}) };
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, title: 'S' + i, artist: 'Silver Jews' }));
  const scope = {
    SJ_BRAND: { id: 'rk' }, sjIsNative: () => true, sjDlPlugin: () => native, console,
    performance: { now: () => 0 }, setTimeout: () => 0, document: { visibilityState: 'visible' },
    ytData: { t0: { video_id: 'v0' } }, loadYT: async () => ({}), findTrackById: () => ({ name: 'S0' }),
    ytAPIPlayer: null, ytPlayerEl: {}, _taAudioEl: null, _taBgActive: true, _taManualAudio: true,
    _taNativeBgActive: true, taSyncAudioBtn() {}, _ytUserWantsPlay: true, ytpIsMob: () => false,
    _ytpFs: true, ytpMobSyncDeck() {}, ytpEnterFullscreen() {}, ytpPaintTogs() {},
    ytQueue: [], ytQueueIdx: 0, ytShuffle: false, ytRepeat: false,
    _sjCarFollow: null, _sjCarFollowDriving: false, _sjCarStandIn: false,
    _sjCarQueueSnapshot: null, _sjCarNextIndex: null, _taNativeQueueSig: '',
    ytQueueItem: (videoId, title, trackId, artist) => ({ videoId, title, trackId, artist }),
    ytpTrackMeta: (id, title) => ({ title, artist: 'Silver Jews' }), taTrackAudio: () => null,
    sjCarFollowAlign() {}, sjCarFollowTime: () => 0,
  };
  // What ytPlayNow does while following: a one-song queue, then a repaint.
  scope.ytPlayNow = (v, t, id) => { scope.ytQueue = [{ videoId: v, title: t, trackId: id }]; scope.ytQueueIdx = 0; scope.updateYTQueueUI(); };
  const api = loadHtmlFnsInScope(['taNativeBgPlugin', 'taNativeQueuePayload', 'taNativeQueueSig',
    'taNativeRememberQueue', 'taNativeSyncQueue', 'sjCarSyncPhoneState', 'sjCarOnNativeStatus', 'sjCarFollowLoad'], scope);
  scope.updateYTQueueUI = () => api.taNativeSyncQueue();

  api.taNativeRememberQueue(ten);   // what taStartNativeBg sent
  await api.sjCarOnNativeStatus({ state: 'playing', trackId: 't0', index: 0, positionSeconds: 1 });
  assert.equal(sent.length, 0, 'the stand-in queue went to native');
  assert.deepEqual(scope.ytQueue.map(q => q.trackId), ten.map(t => t.id));
  assert.equal(scope._sjCarStandIn, false);
});
