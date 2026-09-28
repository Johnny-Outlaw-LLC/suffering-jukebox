// @suite Retired track ratings
// @area Playback
// @covers public/index.html, src/app/api/spotify/history/route.ts, src/lib/my-data-export.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('public/index.html');

test('no rendered control can submit a track or artist rating', () => {
  assert.doesNotMatch(page, /<button[^>]+(?:data-vote-track|onclick="cycleVote|onclick="cycleArtistRating)/);
  assert.doesNotMatch(page, /<button[^>]+data-player-vote/);
});

test('Favorites and Favorites First use hearted track ids', () => {
  const dynamic = page.slice(page.indexOf('function dynamicPlaylistRows()'), page.indexOf('function dynamicPlaylistById('));
  assert.match(dynamic, /myReactionTrackIds/);
  assert.doesNotMatch(dynamic, /localVotes|getMyVote|Favorites Plus/);
  const weights = page.slice(page.indexOf('function _ytShuffleWeightFor('), page.indexOf('function _ytShuffleWeight(idx)'));
  assert.match(weights, /myReactionTrackIds\.includes/);
  assert.doesNotMatch(weights, /getMyVote/);
});

test('analytics and exports do not read legacy rating events', () => {
  assert.doesNotMatch(read('src/app/api/spotify/history/route.ts'), /rating_events|new_rating|thumbs_up/);
  assert.doesNotMatch(read('src/lib/my-data-export.ts'), /rating_events|new_rating|Favorites Plus|Your Rating|Rating At Play/);
});

test('the replacement database score counts hearts only', () => {
  const migration = read('supabase/migrations/20260928120000_retire_track_ratings.sql');
  assert.match(migration, /where tr\.reaction = 'heart'/);
  assert.doesNotMatch(migration, /new_rating|rating_events/);
});
