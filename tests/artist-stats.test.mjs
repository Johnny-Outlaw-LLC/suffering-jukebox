// @suite Artist stats
// @area Artists
// @covers /artist-stats, /api/artist-stats, the listen meter, and play attribution
// Plays are credited to the artist by the server, listen time is measured from
// the media clock, and stats are only for the artist and their managers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, readRepoFile, dashboardHtml, loadHtmlFnsInScope } from './_load.mjs';

const lib = loadTs('src/lib/artist-stats.ts');

const LRC = [
  '[00:47.63]Status Report',
  '[00:49.12]On the female escorts',
  '[01:50.00]The last line',
].join('\n');

test('a heart moment carries the lyric on screen at its midpoint', () => {
  assert.equal(lib.lyricAt(LRC, 40000), 'Status Report');
  assert.equal(lib.lyricAt(LRC, 50000), 'On the female escorts');
});

test('a heart window that opens before the singing takes the first line inside it', () => {
  assert.equal(lib.lyricAt(LRC, 40000), 'Status Report');
  assert.equal(lib.lyricAt(LRC, 0), null);
});

test('an instrumental break is not credited with the last line sung', () => {
  assert.equal(lib.lyricAt(LRC, 90000), null);
  assert.equal(lib.lyricAt(LRC, 110000), 'The last line');
  assert.equal(lib.lyricAt(null, 1000), null);
});

test('referrers fold into the places an artist would recognise', () => {
  const out = lib.groupReferrers([
    { host: '(direct)', visits: 74 },
    { host: 'facebook.com', visits: 54 },
    { host: 'l.facebook.com', visits: 40 },
    { host: 'lm.facebook.com', visits: 14 },
    { host: 'l.instagram.com', visits: 15 },
    { host: '(internal)', visits: 43 },
    { host: 'www.somezine.com', visits: 2 },
    { host: 'localhost', visits: 4 },
    { host: 'accounts.spotify.com', visits: 1 },
  ]);
  assert.deepEqual(out, [
    { source: 'Facebook', visits: 108 },
    { source: 'Direct link or typed in', visits: 74 },
    { source: 'Inside Listening Party', visits: 47 },
    { source: 'Instagram', visits: 15 },
    { source: 'somezine.com', visits: 2 },
    { source: 'Spotify', visits: 1 },
  ]);
});

// ── Listen meter ────────────────────────────────────────────────────────────
function meter({ playing = true, trackId = 't1', follow = false } = {}) {
  const audio = { dataset: { trackId }, currentTime: 0, paused: !playing, muted: false };
  const clock = { now: 0 };
  const saved = [];
  const scope = {
    _lm: { eventId: 'e1', trackId: 't1', ms: 10000, savedMs: 0, pos: null, wall: 0, timer: null },
    _taBgActive: true, _taAudioEl: audio, _sjCarFollow: follow ? {} : null,
    ytAPIPlayer: null, ytQueue: [], ytQueueIdx: 0,
    Date: { now: () => clock.now },
    String,
  };
  // Mirrors lmSave's bookkeeping without the network.
  scope.lmSave = (final) => { saved.push(final); scope._lm.savedMs = Math.round(scope._lm.ms); };
  const fns = loadHtmlFnsInScope(['lmNow', 'lmTick'], scope);
  const at = (wallMs, pos) => { clock.now = wallMs; audio.currentTime = pos; fns.lmTick(); };
  return { scope, audio, at, saved, fns };
}

test('listen time counts media seconds while the song plays', () => {
  const m = meter();
  m.at(0, 10);
  m.at(1000, 11);
  m.at(2000, 12);
  assert.equal(m.scope._lm.ms, 12000);
});

test('a screen-off tab whose timers stall still counts the time it played', () => {
  const m = meter();
  m.at(0, 10);
  m.at(45000, 55); // one tick after 45 seconds of real playback
  assert.equal(m.scope._lm.ms, 55000);
});

test('a seek forward is not a listen, and a pause stops the count', () => {
  const m = meter();
  m.at(0, 10);
  m.at(1000, 90); // jumped ahead 80 seconds in one
  assert.equal(m.scope._lm.ms, 10000);
  m.audio.paused = true;
  m.at(5000, 90);
  m.audio.paused = false;
  m.at(6000, 91); // first tick after resuming only re-anchors
  m.at(7000, 92);
  assert.equal(m.scope._lm.ms, 11000);
});

test('the next song does not add its time to the play before it', () => {
  const m = meter();
  m.at(0, 10);
  m.audio.dataset.trackId = 't2';
  m.at(1000, 1);
  m.at(2000, 2);
  assert.equal(m.scope._lm.ms, 10000);
});

test('progress is saved every 30 seconds of listening, not every tick', () => {
  const m = meter();
  for (let s = 0; s <= 25; s++) m.at(s * 1000, 10 + s);
  assert.equal(m.saved.length, 1);
});

test('the muted copy that follows CarPlay is neither metered nor logged as a play', () => {
  const m = meter({ follow: true });
  m.scope._taBgActive = false;
  assert.equal(m.fns.lmNow(), null);
  assert.match(dashboardHtml, /if \(eventType === 'play' && _sjCarFollow\) return;/);
});

test('every play sends where it happened, and starts the meter', () => {
  assert.match(dashboardHtml, /p_listen_context: eventType === 'play' \? sjListenContext\(\) : null,/);
  assert.match(dashboardHtml, /if \(eventId\) lmStart\(eventId, trackId\);/);
});

// ── Server rules ────────────────────────────────────────────────────────────
const attribution = readRepoFile('supabase/migrations/20261005230000_play_event_server_attribution.sql');
const stats = readRepoFile('supabase/migrations/20261005233000_artist_stats.sql');

test('the server credits a play to the artist and album of the song, not the browser', () => {
  for (const sql of [attribution, stats]) {
    assert.match(sql, /coalesce\(v_artist, left\(nullif\(p_artist_id, ''\), 64\)\)/);
    assert.match(sql, /coalesce\(v_album, left\(nullif\(p_album_id, ''\), 64\)\)/);
  }
});

test('artist_stats is service role only, and the old play logger leaves no overload behind', () => {
  assert.match(stats, /revoke all on function jukebox\.artist_stats\(uuid, integer, text\) from public, anon, authenticated;/);
  assert.match(stats, /drop function if exists jukebox\.log_play_event\(text, text, text, text, text, text, integer, text\);/);
  assert.match(stats, /where listeners >= 3/);
});

test('the stats route signs the user in and checks they may see that artist', () => {
  const route = readRepoFile('src/app/api/artist-stats/route.ts');
  assert.match(route, /const user = await getAuthUser\(req\);\s+if \(!user\)/);
  assert.match(route, /if \(!\(await canViewArtistStats\(sb, user, artist\.id\)\)\)/);
});

test('Artist stats sits beside Manage Artist, for managers only', () => {
  // Both the artist page menu and the artist card menu gate it on lamCanManage.
  const gated = dashboardHtml.match(/lamCanManage\(row\)\s*\?[^:]*?lamManage\(\)[\s\S]{0,300}?: ''\)/g) || [];
  assert.equal(gated.length, 2);
  for (const block of gated) assert.ok(block.includes('lamStats()'), block);
});
