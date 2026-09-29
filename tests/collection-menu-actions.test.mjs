// @suite Collection menu actions
// @area Playback and playlists
// @covers plmAddToPlaylist, plmPlayNext, lamPlayNext in public/index.html
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

test('playlist menu copies its songs to the batch playlist picker in order', async () => {
  let picked;
  const source = { id: 'source', name: 'Favorite songs' };
  const anchor = {};
  const scope = {
    _plmPlaylistId: source.id,
    _plmAnchor: anchor,
    _savedPlaylists: [source],
    playlists: [],
    dbGetAuth: async () => [{ track_id: 'a' }, { track_id: 'b' }],
    plmClose() {},
    openAddTracksToPlaylist: (...args) => { picked = args; },
    showToast: message => { throw new Error(message); },
  };
  const { plmAddToPlaylist, plmTrackIds } = loadHtmlFnsInScope(['plmAddToPlaylist', 'plmTrackIds'], scope);
  scope.plmTrackIds = plmTrackIds;
  await plmAddToPlaylist();
  assert.deepEqual(picked, [['a', 'b'], 'Favorite songs', anchor, null]);
});

test('playlist Play Next preserves source order after the current song', async () => {
  let queued;
  const scope = {
    _plmPlaylistId: 'source',
    ytPlayerEl: {},
    ytQueue: [{ trackId: 'current' }],
    plmClose() {},
    plmTrackIds: async () => ['a', 'b'],
    resolvePlaylistTracks: async () => ({
      a: { videoId: 'video-a', name: 'First' },
      b: { videoId: 'video-b', name: 'Second' },
    }),
    sjNoBlocked: items => items.filter(Boolean),
    ytInsertNextQueueItems: items => { queued = items; },
    showToast() {},
  };
  const { plmPlayNext } = loadHtmlFnsInScope(['plmPlayNext'], scope);
  await plmPlayNext();
  assert.deepEqual(queued.map(item => item.trackId), ['a', 'b']);
});

test('artist Play Next uses the same queue insertion for its playable songs', async () => {
  let queued;
  const scope = {
    _lamArtistId: 'artist',
    ytPlayerEl: {},
    ytQueue: [{ trackId: 'current' }],
    lamClose() {},
    lamAllTrackIds: async () => ['a', 'missing', 'b'],
    resolvePlaylistTracks: async () => ({
      a: { videoId: 'video-a', name: 'First' },
      b: { videoId: 'video-b', name: 'Second' },
    }),
    sjNoBlocked: items => items.filter(Boolean),
    ytInsertNextQueueItems: items => { queued = items; },
    showToast() {},
  };
  const { lamPlayNext } = loadHtmlFnsInScope(['lamPlayNext'], scope);
  await lamPlayNext();
  assert.deepEqual(queued.map(item => item.trackId), ['a', 'b']);
});
