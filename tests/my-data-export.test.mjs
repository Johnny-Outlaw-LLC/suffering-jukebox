import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/my-data-export.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function setup({ liked = true, extra = [] } = {}) {
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => {
    if (name.endsWith('sj-admin-auth')) return { JUKEBOX_SCHEMA: 'jukebox' };
    if (name.endsWith('catalog-index')) return { normTitle: s => s.toLowerCase() };
    if (name.endsWith('bg-audio-eligibility')) return { approvedArtistAudioTracks: async () => [] };
    throw Error(name);
  } });
  const tables = {
    artists: [{ id: 'artist', name: 'Artist' }],
    albums: [{ id: 'album', name: 'Album', artist_id: 'artist' }],
    tracks: ['a', 'b', 'c', 'foreign', ...extra].map(id => ({ id, name: id, album_id: 'album' })),
    track_videos: ['a', 'b', 'c'].map(id => ({ id, track_id: id, video_id: 'video-' + id })),
    feedback: [
      { id: '1', user_email: 'me@example.com', target_type: 'track', track_id: 'a', vote: liked ? 2 : 0 },
      { id: '2', user_email: 'me@example.com', target_type: 'track', track_id: 'c', vote: -1 },
      { id: '3', user_email: 'other@example.com', target_type: 'track', track_id: 'foreign', vote: 1 },
    ],
    track_reactions: ['a', 'b', 'b', ...extra].map((track_id, i) => ({ id: String(i), user_id: 'me', track_id }))
      .concat([{ id: 'foreign', user_id: 'other', track_id: 'foreign' }]),
    track_audio: [], playlists: [], jukeboxes: [],
  };
  const sb = { schema: () => ({ from: name => {
    let rows = tables[name] || [];
    const query = {
      select: () => query, order: () => query,
      eq: (key, value) => { rows = rows.filter(r => r[key] === value); return query; },
      ilike: (key, value) => { rows = rows.filter(r => String(r[key]).toLowerCase() === value); return query; },
      gt: (key, value) => { rows = rows.filter(r => r[key] > value); return query; },
      in: (key, values) => { rows = rows.filter(r => values.includes(r[key])); return query; },
      range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null }),
    };
    return query;
  } }) };
  const user = { id: 'me', email: 'me@example.com' };
  const rows = async (names, background = 'any') => {
    const result = [];
    for await (const row of exports.exportRows(sb, 'playlists', user, { artists: [], playlists: names, background })) result.push(row);
    return result;
  };
  return { exports, sb, user, rows };
}

test('menu includes both Favorites playlists and their artists without saved playlists', async () => {
  const { exports, sb, user } = setup();
  const options = await exports.exportOptions(sb, user);
  assert.deepEqual(Array.from(options.playlists), ['Favorites', 'Favorites Plus']);
  assert.deepEqual(Array.from(options.artists), ['Artist']);
});
test('Favorites exports only positive current votes with YouTube links', async () => {
  const { rows } = setup();
  const result = await rows(['Favorites']);
  assert.deepEqual(result.map(r => r[6]), ['a']);
  assert.equal(result[0][12], 'https://www.youtube.com/watch?v=video-a');
});
test('Favorites Plus deduplicates likes and reactions and excludes other accounts', async () => {
  const { rows } = setup();
  assert.deepEqual((await rows(['Favorites Plus'])).map(r => r[6]), ['a', 'b']);
  assert.equal((await rows(['Favorites Plus'], 'yes')).length, 0);
});
test('reaction-only accounts can export Favorites Plus', async () => {
  const { rows } = setup({ liked: false });
  assert.deepEqual((await rows(['Favorites Plus'])).map(r => r[6]), ['a', 'b']);
});
test('reaction exports page past the first thousand rows', async () => {
  const { rows } = setup({ extra: Array.from({ length: 1001 }, (_, i) => 'extra-' + i) });
  assert.equal((await rows(['Favorites Plus'])).length, 1003);
});
