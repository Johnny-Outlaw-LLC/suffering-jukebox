// @suite Public demo content
// @area Platform
// @covers src/lib/demo-content.ts
// Public demos aggregate only fictional events, with consistent totals and rolling dates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';
const { demoArtistStats, demoListeningEvents, demoAnalytics, demoTrackKey, DEMO_TRACKS } = loadTs('src/lib/demo-content.ts');
const now = new Date('2026-10-05T12:00:00');
const query = { source: 'all', from: '', to: '', artistSel: { mode: 'all' }, trackSel: { mode: 'all' }, bucketMode: 'auto' };

test('artist ranges conserve plays, listening time, and context totals', () => {
  for (const days of [7, 30, 90, 365]) {
    const s = demoArtistStats(days, now);
    assert.equal(s.daily.length, days);
    assert.equal(s.daily.at(-1).day, '2026-10-05');
    assert.equal(s.totals.plays, s.daily.reduce((n, d) => n + d.plays, 0));
    assert.equal(s.totals.plays, s.songs.reduce((n, d) => n + d.plays, 0));
    assert.equal(s.totals.plays, Object.values(s.contexts).reduce((n, d) => n + d, 0));
    assert.equal(s.totals.listen_ms, s.songs.reduce((n, d) => n + d.listen_ms, 0));
    assert.equal(s.totals.page_visits, s.referrers.reduce((n, d) => n + d.visits, 0));
    assert(s.totals.returning_listeners < s.totals.listeners);
    assert(s.songs.every(song => song.completion > 0 && song.completion <= 1));
  }
});
test('listener filters are derived from the same event history', () => {
  const events = demoListeningEvents(now);
  const all = demoAnalytics(query, events);
  assert.equal(all.totals.events, events.length);
  assert.equal(all.totals.duration_ms, events.reduce((sum, event) => sum + event.duration, 0));
  assert.equal(all.totals.events, all.calendar.reduce((sum, day) => sum + day.events, 0));
  assert.equal(all.totals.events, all.series.reduce((sum, bucket) => sum + bucket.events, 0));
  for (const source of ['sj', 'lp', 'spotify', 'youtube']) {
    const filtered = demoAnalytics({ ...query, source, from: '2026-09-06', to: '2026-10-05' }, events);
    assert.equal(filtered.totals.events, events.filter(e => e.source === source && e.day >= '2026-09-06').length);
    assert(filtered.series.every(row => row[source + '_events'] === row.events));
  }
  const youtube = demoAnalytics({ ...query, source: 'youtube' }, events);
  assert.equal(youtube.totals.duration_ms, 0);
  assert(youtube.totals.events > 0);
});
test('artist and song selections actually narrow the demo history', () => {
  const events = demoListeningEvents(now);
  const key = demoTrackKey(DEMO_TRACKS[0]);
  const one = demoAnalytics({ ...query, trackSel: { mode: 'include', keys: [key] } }, events);
  assert.equal(one.totals.tracks, 1);
  assert.equal(one.totals.events, events.filter(e => e.track === 0).length);
  const none = demoAnalytics({ ...query, artistSel: { mode: 'none' } }, events);
  assert.equal(none.totals.events, 0);
});
test('a demo import changes availability, not listening totals or the original fixture', () => {
  const events = demoListeningEvents(now);
  const key = demoTrackKey(DEMO_TRACKS[6]);
  const before = demoAnalytics(query, events);
  assert.equal(before.topTracks.find(t => t.key === key).in_jukebox, false);
  const after = demoAnalytics(query, events, new Set([key]));
  assert.equal(after.topTracks.find(t => t.key === key).in_jukebox, true);
  assert.deepEqual(after.totals, before.totals);
  assert.equal(demoAnalytics(query, events).topTracks.find(t => t.key === key).in_jukebox, false);
});
test('dates remain current across a year boundary and a leap day', () => {
  for (const date of ['2027-01-01', '2028-02-29']) {
    const today = new Date(date + 'T12:00:00');
    assert.equal(demoArtistStats(30, today).daily.at(-1).day, date);
    assert.equal(demoListeningEvents(today).at(-1).day, date);
    const s = demoArtistStats(30, today);
    assert(s.daily.every((d, i) => i === 0 || d.day > s.daily[i - 1].day));
  }
});
