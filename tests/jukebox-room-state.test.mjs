// @suite Listeners and broadcast state
// @area Online Jukebox
// @covers src/lib/jukebox.ts playback, listeners, broadcast expiry
//
// Three questions the room keeps confusing with each other: is this room OPEN
// (is_live), is music actually being played into it right now (broadcastingNow),
// and has somebody left a station advertising itself and walked away
// (broadcastExpired). Plus who counts as being in the room at all.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

const jb = loadTs('src/lib/jukebox.ts');

const NOW = Date.parse('2026-09-10T21:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

// ── Playback blob ─────────────────────────────────────────────────────────

test('an empty playback blob normalizes to the documented empty state', () => {
  assert.deepStrictEqual(jb.normalizePlayback(null), jb.EMPTY_PLAYBACK);
  assert.deepStrictEqual(jb.normalizePlayback({}), jb.EMPTY_PLAYBACK);
});

test('a stuck client cannot write a nonsense position into the room', () => {
  const pb = jb.normalizePlayback({
    positionMs: -500,
    durationMs: 99 * HOUR,
    lyricOffsetMs: 'nope',
    isPlaying: 'true',
  });
  assert.equal(pb.positionMs, 0);
  assert.equal(pb.durationMs, 6 * HOUR, 'six hours caps it; nothing here is that long');
  assert.equal(pb.lyricOffsetMs, 0);
  assert.equal(pb.isPlaying, false, 'only a real boolean counts as playing');
});

test('playback strings are trimmed, capped and blanked rather than stored raw', () => {
  const pb = jb.normalizePlayback({ videoId: '  abc  ', title: 'x'.repeat(500), artistName: '   ' });
  assert.equal(pb.videoId, 'abc');
  assert.equal(pb.title.length, 200);
  assert.equal(pb.artistName, null);
});

// ── Extrapolating between polls ───────────────────────────────────────────

test('a guest extrapolates from the last push rather than waiting for the next', () => {
  const pb = jb.normalizePlayback({ positionMs: 30_000, durationMs: 200_000, isPlaying: true });
  assert.equal(jb.projectedPositionMs(pb, 4_000), 34_000);
});

test('extrapolation never runs off the end of the song, and a pause does not move', () => {
  const playing = jb.normalizePlayback({ positionMs: 190_000, durationMs: 200_000, isPlaying: true });
  assert.equal(jb.projectedPositionMs(playing, 60_000), 200_000);

  const paused = jb.normalizePlayback({ positionMs: 30_000, durationMs: 200_000 });
  assert.equal(jb.projectedPositionMs(paused, 60_000), 30_000);

  const live = jb.normalizePlayback({ positionMs: 10_000, isPlaying: true });
  assert.equal(jb.projectedPositionMs(live, 5_000), 15_000, 'a stream with no duration still runs on');
});

// ── On air versus actually playing ────────────────────────────────────────

const playback = (over = {}) =>
  jb.normalizePlayback({ videoId: 'v1', isPlaying: true, updatedAt: ago(3_000), ...over });

test('a room with nothing on screen is not broadcasting whatever it last said', () => {
  assert.equal(jb.broadcastingNow({ playback: null, nowMs: NOW }), false);
  assert.equal(jb.broadcastingNow({ playback: playback({ videoId: null }), nowMs: NOW }), false);
});

test('a host whose tab was shut stops counting as playing after a couple of minutes', () => {
  assert.equal(jb.broadcastingNow({ playback: playback(), nowMs: NOW }), true);
  assert.equal(
    jb.broadcastingNow({ playback: playback({ updatedAt: ago(3 * MIN) }), nowMs: NOW }),
    false,
    'two minutes is a couple of dozen missed pushes',
  );
  assert.equal(jb.broadcastingNow({ playback: playback({ updatedAt: null }), nowMs: NOW }), false);
});

test('a pause between songs is not the end of the night, but a long one is', () => {
  const shortPause = playback({ isPlaying: false, playingAt: ago(90_000) });
  assert.equal(jb.broadcastingNow({ playback: shortPause, nowMs: NOW }), true);

  const gone = playback({ isPlaying: false, playingAt: ago(20 * MIN) });
  assert.equal(jb.broadcastingNow({ playback: gone, nowMs: NOW }), false);

  const neverPlayed = playback({ isPlaying: false, playingAt: null });
  assert.equal(jb.broadcastingNow({ playback: neverPlayed, nowMs: NOW }), false);
});

test('opening the room hours before the music starts is not an expired broadcast', () => {
  // A host who opens the room at six and starts the music at ten has done
  // nothing wrong. Expiry is measured from the LATER of the two stamps.
  assert.equal(
    jb.broadcastExpired({
      isLive: true,
      playbackUpdatedAt: null,
      lastLiveAt: ago(3 * HOUR),
      nowMs: NOW,
    }),
    false,
  );
  assert.equal(
    jb.broadcastExpired({
      isLive: true,
      playbackUpdatedAt: ago(MIN),
      lastLiveAt: ago(20 * HOUR),
      nowMs: NOW,
    }),
    false,
    'the music is what matters, not when the room opened',
  );
});

test('a station left advertising itself with nothing playing eventually closes', () => {
  assert.equal(
    jb.broadcastExpired({
      isLive: true,
      playbackUpdatedAt: ago(7 * HOUR),
      lastLiveAt: ago(9 * HOUR),
      nowMs: NOW,
    }),
    true,
  );
});

test('a room that is already off air, or that we cannot date, is left alone', () => {
  assert.equal(
    jb.broadcastExpired({ isLive: false, playbackUpdatedAt: ago(20 * HOUR), lastLiveAt: null, nowMs: NOW }),
    false,
  );
  assert.equal(
    jb.broadcastExpired({ isLive: true, playbackUpdatedAt: null, lastLiveAt: null, nowMs: NOW }),
    false,
    'a room from before any of this existed is not switched off on a guess',
  );
});

// ── Who is in the room ────────────────────────────────────────────────────

const guest = (id, over = {}) => ({
  id,
  display_name: null,
  guest_no: 1,
  is_banned: false,
  created_at: ago(3 * HOUR),
  last_seen_at: ago(2_000),
  session_started_at: null,
  ...over,
});

test('anybody who has stopped polling is dropped, not greyed out', () => {
  // A guest row is permanent. A list that kept them became every phone that had
  // ever scanned the code, under a heading reading "0 listening".
  const rows = [guest('here'), guest('gone', { last_seen_at: ago(10 * MIN) })];
  const out = jb.shapeListeners(rows, NOW);
  assert.deepStrictEqual(out.map((l) => l.id), ['here']);
});

test('a row with an unreadable last-seen stamp is dropped rather than trusted', () => {
  assert.deepStrictEqual(jb.shapeListeners([guest('x', { last_seen_at: 'not a date' })], NOW), []);
});

test('how long somebody has been here is this stretch, not the night they first scanned', () => {
  const regular = guest('regular', {
    created_at: ago(30 * 24 * HOUR),
    session_started_at: ago(20 * MIN),
  });
  const [listener] = jb.shapeListeners([regular], NOW);
  assert.equal(listener.listeningMs, 20 * MIN);
  assert.equal(listener.since, ago(20 * MIN));
});

test('with no session stamp the first sighting is the best answer available', () => {
  const [listener] = jb.shapeListeners([guest('x', { created_at: ago(9 * MIN) })], NOW);
  assert.equal(listener.listeningMs, 9 * MIN);
});

test('the panel is ordered longest-standing first', () => {
  const rows = [
    guest('new', { session_started_at: ago(MIN) }),
    guest('old', { session_started_at: ago(2 * HOUR) }),
    guest('mid', { session_started_at: ago(30 * MIN) }),
  ];
  assert.deepStrictEqual(jb.shapeListeners(rows, NOW).map((l) => l.id), ['old', 'mid', 'new']);
});

test('guests are never given a name, they are given a number', () => {
  assert.equal(jb.displayNameFor({ display_name: null, guest_no: 4 }), 'Listener 4');
  assert.equal(jb.displayNameFor({ display_name: '   ', guest_no: 7 }), 'Listener 7');
  assert.equal(jb.displayNameFor({ display_name: 'Renee', guest_no: 7 }), 'Renee');
  assert.equal(jb.displayNameFor({}), 'Listener 1');
});

test('a typed name cannot break the TV layout, and is not otherwise filtered', () => {
  assert.equal(jb.sanitizeDisplayName('  Big   Steve \n'), 'Big Steve');
  assert.equal(jb.sanitizeDisplayName('a b'), 'a b');
  assert.equal(jb.sanitizeDisplayName('   '), null);
  assert.equal(jb.sanitizeDisplayName(42), null);
  assert.equal(jb.sanitizeDisplayName('x'.repeat(200)).length, jb.MAX_DISPLAY_NAME);
});

test('the listening clock reads the way a person would say it', () => {
  assert.equal(jb.formatListeningFor(20_000), 'just arrived');
  assert.equal(jb.formatListeningFor(9 * MIN), '9m');
  assert.equal(jb.formatListeningFor(HOUR), '1h');
  assert.equal(jb.formatListeningFor(HOUR + 12 * MIN), '1h 12m');
});
