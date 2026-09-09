import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('a shuffle preference persists immediately and resets the active shuffle bag', () => {
  const from = html.indexOf('const SJ_SHUFFLE_PREFERENCES =');
  const to = html.indexOf('let _ytUserWantsPlay', from);
  assert.ok(from > 0 && to > from, 'could not locate shuffle preference state');

  const stored = new Map([['sj_shuffle_preference', 'less_repeats']]);
  let resetCount = 0;
  const context = vm.createContext({
    localStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
    },
    ytShuffle: true,
    _ytShufflePreviewIdx: 42,
    ytPlayerEl: null,
    ytResetShufflePool: () => { resetCount++; },
    updateYTQueueUI() {},
  });
  vm.runInContext(html.slice(from, to) + '\nglobalThis.__preference = () => sjShufflePreference;', context);

  assert.equal(context.__preference(), 'less_repeats');
  assert.equal(context.sjSetShufflePreference('favorites'), true);
  assert.equal(stored.get('sj_shuffle_preference'), 'favorites');
  assert.equal(context.__preference(), 'favorites');
  assert.equal(resetCount, 1);
  assert.equal(context.sjSetShufflePreference('not-a-real-mode'), false);
  assert.equal(context.__preference(), 'favorites');
});

test('every Explore-page Shuffle All path uses the weighted playback engine', () => {
  const blocks = [
    ['function playlistsShuffleAll()', 'async function playPlaylist('],
    ['async function landingShuffleAll()', 'async function landingShuffleFavorites()'],
    ['async function landingShuffleFavorites()', 'const _laLoadedArtists'],
  ];
  for (const [start, end] of blocks) {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from);
    assert.ok(from > 0 && to > from, `could not locate ${start}`);
    const block = html.slice(from, to);
    assert.match(block, /landingPlayQueue\(q, \{ shuffle: true \}\)/);
    assert.doesNotMatch(block, /shuffleInPlace\(q\)/);
  }
});
