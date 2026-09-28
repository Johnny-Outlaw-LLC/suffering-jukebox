// @suite Exporting your own data
// @area Accounts
// @covers src/lib/my-data-export.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/my-data-export.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function setup({ extra = [] } = {}) {
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
    track_reactions: ['a', 'b', 'b', ...extra].map((track_id, i) => ({ id: String(i), user_id: 'me', track_id, reaction: 'heart' }))
      .concat([{ id: 'foreign', user_id: 'other', track_id: 'foreign', reaction: 'heart' }]),
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

test('menu includes the heart-based Favorites playlist and its artists', async () => {
  const { exports, sb, user } = setup();
  const options = await exports.exportOptions(sb, user);
  assert.deepEqual(Array.from(options.playlists), ['Favorites']);
  assert.deepEqual(Array.from(options.artists), ['Artist']);
});
test('Favorites exports hearted songs once with YouTube links', async () => {
  const { rows } = setup();
  const result = await rows(['Favorites']);
  assert.deepEqual(result.map(r => r[6]), ['a', 'b']);
  assert.equal(result[0][12], 'https://www.youtube.com/watch?v=video-a');
});
test('Favorites excludes other accounts and obeys filters', async () => {
  const { rows } = setup();
  assert.deepEqual((await rows(['Favorites'])).map(r => r[6]), ['a', 'b']);
  assert.equal((await rows(['Favorites'], 'yes')).length, 0);
});
test('reaction exports page past the first thousand rows', async () => {
  const { rows } = setup({ extra: Array.from({ length: 1001 }, (_, i) => 'extra-' + i) });
  assert.equal((await rows(['Favorites'])).length, 1003);
});
