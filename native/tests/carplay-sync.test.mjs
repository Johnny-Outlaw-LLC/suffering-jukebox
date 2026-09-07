import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
function extract(name) {
  const start = html.indexOf('async function ' + name + '(');
  const end = html.indexOf('\n}', start) + 2;
  return html.slice(start, end);
}
function setup(extra = {}) {
  const pushed = [];
  const ctx = vm.createContext({
    _sjCarPlaylistsLoaded: false, _savedPlaylists: [], playlists: [], pubPlaylists: [],
    googleUser: { email: 'me@example.com' },
    sjGetSession: async () => ({ data: { session: { access_token: 'test' } } }),
    sjApiUrl: path => 'https://sufferingjukebox.stream' + path,
    dynamicPlaylistRows: () => [{ id: 'favorites', name: 'Favorites', _tracks: [{ track_id: 'fav' }] }],
    sjDlPlugin: () => ({ setPlaylists: async value => pushed.push(value) }),
    ...extra,
  });
  vm.runInContext(extract('sjCarPushPlaylists') + '\n' + extract('loadPlaylists'), ctx);
  return { ctx, pushed };
}
test('saved playlists use live API and sync before JS download index is ready', async () => {
  const { ctx, pushed } = setup({ fetch: async url => {
    assert.equal(url, 'https://sufferingjukebox.stream/api/playlist-share');
    return { ok: true, json: async () => ({ ok: true, playlists: [
      { id: 'sj', name: 'Silver Jews + Pavement', _tracks: [{ track_id: 'b' }, { track_id: 'a' }] },
      { id: 'em', name: 'Essential Eminem', _tracks: [{ track_id: 'e' }] },
    ] }) };
  } });
  await ctx.loadPlaylists();
  assert.equal(pushed[0].playlists.length, 3);
  assert.equal(pushed[0].playlists[0].trackIds.join(','), 'b,a');
});
test('startup and failed fetch do not replace offline playlists with Favorites', async () => {
  const { ctx, pushed } = setup({ fetch: async () => { throw Error('offline'); } });
  await ctx.sjCarPushPlaylists();
  await ctx.loadPlaylists();
  assert.equal(pushed.length, 0);
});
test('Silver Jews artwork repair uses the same album override as the web', async () => {
  let tracks;
  const ctx = vm.createContext({
    console, ALBUM_ART: { 'American Water': 'https://covers.example/american-water.jpg' },
    sjDlPlugin: () => ({ backfillArtwork: async value => { tracks = value.tracks; return { repaired: 1 }; } }),
    dbGet: async path => path.startsWith('/tracks')
      ? [{ id: 'song', album_id: 'album' }]
      : [{ id: 'album', name: 'American Water', art_url: null }],
  });
  vm.runInContext(extract('sjDlBackfillArtwork'), ctx);
  await ctx.sjDlBackfillArtwork([{ trackId: 'song' }]);
  assert.equal(tracks[0].artworkUrl, 'https://covers.example/american-water.jpg');
});
