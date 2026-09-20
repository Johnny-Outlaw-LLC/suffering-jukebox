// @suite Album lyrics splitting
// @area Lyrics
// @covers public/index.html sjParseAlbumLyrics sjLyrScore sjLyrHeading
//
// One paste in, one section per song out. The album's own track list is the
// oracle: a line is a heading when it reads like one of these songs, which is
// what lets "1. Title", "[Title]", "## Title" and a bare title all work
// without a rule for each.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFns } from './_load.mjs';

const { sjParseAlbumLyrics, sjLyrScore, sjLyrHeading } = loadHtmlFns([
  'sjLyrFold', 'sjLyrBare', 'sjLyrBigrams', 'sjLyrDice', 'sjLyrScore',
  'sjLyrHeading', 'sjParseAlbumLyrics',
]);

const ALBUM = [
  { id: 't1', name: 'Tired of Sex', track_number: 1 },
  { id: 't2', name: 'Getchoo', track_number: 2 },
  { id: 't3', name: 'No Other One', track_number: 3 },
  { id: 't4', name: 'Why Bother?', track_number: 4 },
  { id: 't5', name: 'Across the Sea', track_number: 5 },
  { id: 't6', name: 'El Scorcho', track_number: 6 },
];

const split = (text, tracks = ALBUM) =>
  sjParseAlbumLyrics(text, tracks).sections.map((s) => [s.track ? s.track.name : null, s.body]);

test('numbered headings split the paste', () => {
  assert.deepEqual(split('1. Tired of Sex\nfirst words\n\n2. Getchoo\nsecond words'), [
    ['Tired of Sex', 'first words'],
    ['Getchoo', 'second words'],
  ]);
});

test('a bare title on its own line is a heading', () => {
  assert.deepEqual(split('Across the Sea\nfirst words\n\nEl Scorcho\nsecond words'), [
    ['Across the Sea', 'first words'],
    ['El Scorcho', 'second words'],
  ]);
});

test('markdown, brackets and capitals all read as headings', () => {
  assert.deepEqual(split('## Why Bother?\nfirst words\n\n[No Other One]\nsecond words\n\nEL SCORCHO\nthird words'), [
    ['Why Bother?', 'first words'],
    ['No Other One', 'second words'],
    ['El Scorcho', 'third words'],
  ]);
});

test('a parenthetical suffix still finds the song', () => {
  assert.deepEqual(split('Across the Sea (Remastered 2016)\nwords'), [['Across the Sea', 'words']]);
});

// The bug this guards: a prefix match that ignored length scored the lyric
// "Why bother, it's gonna hurt me" as highly against "Why Bother?" as the
// heading did, so the lyric became a heading and ate the verse under it.
test('a lyric that starts with the song title is not a heading', () => {
  assert.deepEqual(split("Why Bother?\nWhy bother, it's gonna hurt me\nIt's gonna hurt me"), [
    ['Why Bother?', "Why bother, it's gonna hurt me\nIt's gonna hurt me"],
  ]);
  assert.ok(sjLyrScore("Why bother, it's gonna hurt me", 'Why Bother?') < 0.78);
});

test('song-structure markers stay inside the verse', () => {
  const [[track, body]] = split('El Scorcho\n[Verse 1]\nwords\n\n[Chorus]\nmore words');
  assert.equal(track, 'El Scorcho');
  assert.equal(body, '[Verse 1]\nwords\n\n[Chorus]\nmore words');
});

test('a repeated title on its own line mid-verse does not re-split', () => {
  assert.equal(split('El Scorcho\nwords\nI do\nAcross the Sea').length, 1);
});

test('songs run together without blank lines still split', () => {
  assert.deepEqual(split('Tired of Sex\nfirst words\nGetchoo\nsecond words'), [
    ['Tired of Sex', 'first words'],
    ['Getchoo', 'second words'],
  ]);
});

test('a numbered heading with no title falls back to the track number', () => {
  assert.deepEqual(split('1.\nfirst words\n\n2.\nsecond words'), [
    ['Tired of Sex', 'first words'],
    ['Getchoo', 'second words'],
  ]);
});

test('a title the album does not carry is left unassigned, never guessed', () => {
  assert.deepEqual(split('Getchu\nwords'), [[null, 'Getchu\nwords']]);
});

test('two headings for one song leave the stronger claim holding it', () => {
  assert.deepEqual(split('El Scorcho (demo)\nweaker words\n\nEl Scorcho\nreal words'), [
    [null, 'weaker words'],
    ['El Scorcho', 'real words'],
  ]);
});

test('a header block before the first song is dropped', () => {
  assert.deepEqual(split('Pinkerton B-Sides\nWeezer, 1996\n\n1. Getchoo\nwords'), [['Getchoo', 'words']]);
});

test('a paste with no headings at all comes back as one unassigned section', () => {
  assert.deepEqual(split('a wall of words\nwith no titles'), [[null, 'a wall of words\nwith no titles']]);
});

test('windows line endings behave like unix ones', () => {
  assert.deepEqual(split('1. Getchoo\r\nwords\r\n\r\n2. No Other One\r\nmore'), [
    ['Getchoo', 'words'],
    ['No Other One', 'more'],
  ]);
});

test('an empty paste produces nothing to save', () => {
  assert.deepEqual(sjParseAlbumLyrics('   ', ALBUM).sections, []);
});

test('headings are read out of their many written forms', () => {
  assert.deepEqual(sjLyrHeading('## 03 - No Other One'), { title: 'No Other One', number: 3 });
  assert.deepEqual(sjLyrHeading('[Getchoo]'), { title: 'Getchoo', number: null });
  assert.deepEqual(sjLyrHeading('Track 5: Across the Sea'), { title: 'Across the Sea', number: 5 });
  assert.equal(sjLyrHeading('   '), null);
});
