// @suite Gapless playback
// @area Playback
// @covers glPeekNext, glOnIdleState, glTryHandoff, glOnActivePlaying, glCancel in public/index.html
//
// Every song is its own YouTube video, so the plain advance leaves 0.5 to 2
// seconds of silence between songs (measured 780 ms on The Pros and Cons of
// Hitch Hiking). The idle player slot preloads the next song and takes over at
// the seam. The failure modes are quiet ones: preloading a different song than
// the one Next will pick plays the wrong track, a handoff that skips the queue
// bookkeeping leaves the title, lyrics and play log on the old song, and an
// outgoing player left audible doubles the music across the seam.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

function fakePlayer(over = {}) {
  const calls = [];
  const p = {
    calls,
    state: 1, time: 0, duration: 200, muted: false, volume: 100,
    getPlayerState() { return p.state; },
    getCurrentTime() { return p.time; },
    getDuration() { return p.duration; },
    isMuted() { return p.muted; },
    getVolume() { return p.volume; },
    setVolume(v) { calls.push(['setVolume', v]); p.volume = v; },
    mute() { calls.push(['mute']); p.muted = true; },
    unMute() { calls.push(['unMute']); p.muted = false; },
    playVideo() { calls.push(['playVideo']); },
    pauseVideo() { calls.push(['pauseVideo']); },
    seekTo(t) { calls.push(['seekTo', t]); },
    loadVideoById(id) { calls.push(['loadVideoById', id]); },
    ...over,
  };
  return p;
}

const queue = ['a', 'b', 'c'].map((id) => ({ trackId: id, videoId: 'v-' + id, title: id }));

function harness(over = {}) {
  const a = fakePlayer({ time: 199.9 });
  const b = fakePlayer({ state: 2, muted: true, volume: 0 });
  const log = [];
  const scope = {
    ytQueue: queue, ytQueueIdx: 0, ytShuffle: false, ytRepeat: false,
    _ytActiveSlot: 'a', _ytSlotPlayers: { a, b }, ytAPIPlayer: a,
    _gl: null, _glFire: null, _glOutgoing: null, _glStartAt: 0, _glLead: 0.15, _glTimer: 1,
    _ytUserWantsPlay: true,
    ytPlayNextIndex: () => -1,
    ytUpNextIndex: () => 2,
    ytpSlotPlayer: (s) => scope._ytSlotPlayers[s],
    ytpSyncAPIPointer: () => { scope.ytAPIPlayer = scope._ytSlotPlayers[scope._ytActiveSlot]; },
    ytpSetSlotVisible: (s) => log.push(['visible', s]),
    ytpSliderVolume: () => 80,
    glAvailable: () => true,
    lyrSyncStop: () => log.push(['lyrSyncStop']),
    patchYTPlayDuration: () => log.push(['patchYTPlayDuration', scope._ytActiveSlot]),
    ytPlayQueueIdx: (idx, opts) => { log.push(['ytPlayQueueIdx', idx, opts]); scope.ytQueueIdx = idx; },
    setTimeout: () => 0, clearTimeout: () => {},
    performance: { now: () => 1000 },
    ...over,
  };
  const fns = loadHtmlFnsInScope(['glPeekNext', 'glOnIdleState', 'glTryHandoff', 'glOnActivePlaying', 'glCancel'], scope);
  return { scope, fns, a, b, log };
}

test('the preload targets exactly the song Next will pick', () => {
  const { scope, fns } = harness();
  assert.equal(fns.glPeekNext(), 1, 'plain order: the following song');
  scope.ytQueueIdx = 2;
  assert.equal(fns.glPeekNext(), -1, 'end of the queue without repeat: nothing');
  scope.ytRepeat = true;
  assert.equal(fns.glPeekNext(), 0, 'repeat wraps to the top');
  scope.ytShuffle = true;
  assert.equal(fns.glPeekNext(), 2, 'shuffle uses the reserved Up next pick');
  scope.ytPlayNextIndex = () => 1;
  assert.equal(fns.glPeekNext(), 1, 'an explicit Play next beats everything');
});

test('the idle slot is parked at 0:00 once it starts playing, and only then', () => {
  const { scope, fns, b } = harness();
  scope._gl = { idx: 1, videoId: 'v-b', slot: 'b', token: 1, ready: false };
  fns.glOnIdleState('b', { data: 3 });
  assert.equal(scope._gl.ready, false, 'still buffering');
  fns.glOnIdleState('b', { data: 1 });
  assert.equal(scope._gl.ready, true);
  assert.deepEqual(b.calls, [['pauseVideo'], ['seekTo', 0]]);
});

test('a handoff swaps slots, keeps the volume, and runs the normal track bookkeeping', () => {
  const { scope, fns, a, b, log } = harness();
  scope._gl = { idx: 1, videoId: 'v-b', slot: 'b', token: 1, ready: true };
  assert.equal(fns.glTryHandoff(1), true);
  assert.equal(scope._ytActiveSlot, 'b');
  assert.equal(scope.ytAPIPlayer, b);
  assert.equal(scope._gl, null);
  // The outgoing listen is closed while it is still the active player.
  assert.deepEqual(log.find((e) => e[0] === 'patchYTPlayDuration'), ['patchYTPlayDuration', 'a']);
  assert.deepEqual(log.find((e) => e[0] === 'ytPlayQueueIdx'), ['ytPlayQueueIdx', 1, { skipLoad: true }]);
  assert.deepEqual(b.calls, [['setVolume', 80], ['unMute'], ['playVideo']]);
  assert.equal(scope._glOutgoing, a, 'outgoing is remembered so its tail can be silenced');
  // The incoming song reports PLAYING: the outgoing tail goes quiet.
  fns.glOnActivePlaying();
  assert.equal(a.muted, true);
  assert.equal(scope._glOutgoing, null);
});

test('a mid-song Next onto the preloaded song silences the old one at once', () => {
  const { scope, fns, a } = harness();
  a.time = 150; // 50 s left
  scope._gl = { idx: 1, videoId: 'v-b', slot: 'b', token: 1, ready: true };
  assert.equal(fns.glTryHandoff(1), true);
  assert.ok(a.calls.some((c) => c[0] === 'pauseVideo'));
});

test('no handoff when the preload is not ready or is for a different song', () => {
  const { scope, fns } = harness();
  scope._gl = { idx: 1, videoId: 'v-b', slot: 'b', token: 1, ready: false };
  assert.equal(fns.glTryHandoff(1), false, 'not buffered yet');
  scope._gl.ready = true;
  assert.equal(fns.glTryHandoff(2), false, 'Next chose another song');
  scope._gl = { idx: 1, videoId: 'v-other', slot: 'b', token: 1, ready: true };
  assert.equal(fns.glTryHandoff(1), false, 'queue changed under the preload');
  assert.equal(scope._ytActiveSlot, 'a');
});

test('cancelling stops and mutes the idle slot but never the live one', () => {
  const { scope, fns, a, b } = harness();
  scope._gl = { idx: 1, videoId: 'v-b', slot: 'b', token: 1, ready: true };
  fns.glCancel();
  assert.equal(scope._gl, null);
  assert.deepEqual(b.calls, [['pauseVideo'], ['mute']]);
  scope._gl = { idx: 1, videoId: 'v-b', slot: 'a', token: 2, ready: true };
  fns.glCancel();
  assert.deepEqual(a.calls, [], 'the playing slot is left alone');
});
