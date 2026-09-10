// @suite Matching a folder of files to the catalogue
// @area Import
// @covers src/lib/catalog-index.ts resolveCandidate
// The folder uploader in Settings -> Audio Storage sends one guess per file
// (title, artist, album, length) and gets back one track id, so everything
// that decides which song a file IS lives in resolveCandidate. These cover the
// shapes real folders arrive in: proper tags, a raw YouTube upload title on
// our side, no artist at all, and two bands with the same song name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/catalog-index.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const exports = {};
vm.runInNewContext(js, {
  exports,
  require: (name) => {
    if (name.endsWith('sj-admin-auth')) return { JUKEBOX_SCHEMA: 'jukebox' };
    throw new Error('unexpected require: ' + name);
  },
  console,
  Date,
});
const { emptyResolveIndex, addToResolveIndex, resolveCandidate } = exports;

function indexOf(rows) {
  const index = emptyResolveIndex();
  rows.forEach((row) => addToResolveIndex(index, row));
  return index;
}

const track = (id, name, artist, album, durationMs = null) => ({
  id, name, duration_ms: durationMs, albums: { name: album, artists: { name: artist } },
});

test('tagged file finds its song', () => {
  const index = indexOf([track('t1', 'Random Rules', 'Silver Jews', 'American Water')]);
  const hit = resolveCandidate([index], { title: 'Random Rules', artist: 'Silver Jews', album: 'American Water' });
  assert.equal(hit.trackId, 't1');
  assert.equal(hit.weak, false);
});

test('a raw YouTube upload title on our side still matches a clean tag', () => {
  const index = indexOf([track('t1', 'Silver Jews - Random Rules  HQ', 'Silver Jews - Topic', 'American Water')]);
  const hit = resolveCandidate([index], { title: 'Random Rules', artist: 'Silver Jews' });
  assert.equal(hit.trackId, 't1');
});

test('the right band wins when two share a song title', () => {
  const index = indexOf([
    track('t1', 'Alive', 'Pearl Jam', 'Ten'),
    track('t2', 'Alive', 'Sonic Youth', 'Dirty'),
  ]);
  assert.equal(resolveCandidate([index], { title: 'Alive', artist: 'Sonic Youth' }).trackId, 't2');
  assert.equal(resolveCandidate([index], { title: 'Alive', artist: 'Pearl Jam' }).trackId, 't1');
});

test('an untagged file in a folder we do not recognise falls back to the title, and says so', () => {
  const index = indexOf([track('t1', 'Trains Across the Sea', 'Silver Jews', 'Starlite Walker')]);
  const hit = resolveCandidate([index], { title: 'Trains Across the Sea', artist: 'My Ripped CDs' });
  assert.equal(hit.trackId, 't1');
  assert.equal(hit.weak, true, 'no artist behind it means the listener should look');
});

test('with no artist, a partial title is refused rather than guessed', () => {
  const index = indexOf([track('t1', 'True Love Will Find You In The End', 'Daniel Johnston', 'Retired Boxer')]);
  assert.equal(resolveCandidate([index], { title: 'True Love' }), null);
});

test('a title that matches nothing matches nothing', () => {
  const index = indexOf([track('t1', 'Random Rules', 'Silver Jews', 'American Water')]);
  assert.equal(resolveCandidate([index], { title: 'Enter Sandman', artist: 'Metallica' }), null);
});

test('a badly wrong length is flagged, not silently accepted', () => {
  const index = indexOf([track('t1', 'Smells Like Teen Spirit', 'Nirvana', 'Nevermind', 301000)]);
  const same = resolveCandidate([index], { title: 'Smells Like Teen Spirit', artist: 'Nirvana', durationSeconds: 301 });
  const live = resolveCandidate([index], { title: 'Smells Like Teen Spirit', artist: 'Nirvana', durationSeconds: 600 });
  assert.equal(same.weak, false);
  assert.equal(live.weak, true, 'five minutes out is exactly what a person would not spot from the title');
  assert.ok(live.score < same.score);
});

test('the listener’s private import is searched alongside the public catalogue', () => {
  const shared = indexOf([track('t1', 'Random Rules', 'Silver Jews', 'American Water')]);
  const mine = indexOf([track('p1', 'Snow Is Falling In Manhattan', 'Purple Mountains', 'Purple Mountains')]);
  const hit = resolveCandidate([shared, mine], { title: 'Snow Is Falling In Manhattan', artist: 'Purple Mountains' });
  assert.equal(hit.trackId, 'p1');
});
