// @suite Reading what somebody pasted into Add music
// @area Import
// @covers src/lib/import-intake.ts parseIntake songFromLine parseYouTubeLink songCandidates songsFromPairs
// The one Add music box takes a link, a song, an artist or a whole list. These
// cover the shapes that actually get pasted: share-sheet text around a link,
// setlists with numbering, YouTube descriptions with timestamps, and the lines
// that look like a split but are a single title.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

const intake = loadTs('src/lib/import-intake.ts');

test('YouTube links: videos, playlists, channels, and what is not a link', () => {
  assert.deepEqual(intake.parseYouTubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    { type: 'video', videoId: 'dQw4w9WgXcQ', playlistId: null });
  assert.deepEqual(intake.parseYouTubeLink('youtu.be/dQw4w9WgXcQ?si=abc'),
    { type: 'video', videoId: 'dQw4w9WgXcQ', playlistId: null });
  assert.deepEqual(intake.parseYouTubeLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij'),
    { type: 'video', videoId: 'dQw4w9WgXcQ', playlistId: 'PLabcdefghij' });
  assert.equal(intake.parseYouTubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ').playlistId, null,
    'a radio mix is not a playlist anyone can fetch');
  assert.deepEqual(intake.parseYouTubeLink('https://youtube.com/shorts/dQw4w9WgXcQ'),
    { type: 'video', videoId: 'dQw4w9WgXcQ', playlistId: null });
  assert.deepEqual(intake.parseYouTubeLink('https://www.youtube.com/playlist?list=PLabcdefghij'),
    { type: 'playlist', playlistId: 'PLabcdefghij' });
  assert.deepEqual(intake.parseYouTubeLink('https://www.youtube.com/@silverjews/videos'),
    { type: 'channel', url: 'https://www.youtube.com/@silverjews' });
  assert.equal(intake.parseYouTubeLink('dQw4w9WgXcQ'), null, 'a bare id is a word in this box');
  assert.equal(intake.parseYouTubeLink('https://open.spotify.com/track/abc'), null);
});

test('a link with share-sheet words around it is still one link', () => {
  const r = intake.parseIntake('Check out this video\nhttps://youtu.be/dQw4w9WgXcQ');
  assert.equal(r.kind, 'link');
  assert.equal(r.link.videoId, 'dQw4w9WgXcQ');
});

test('one line with no separator is a search, one with a separator is a song', () => {
  assert.deepEqual(intake.parseIntake('Silver Jews'), { kind: 'query', query: 'Silver Jews' });
  const r = intake.parseIntake('Pavement - Gold Soundz');
  assert.equal(r.kind, 'songs');
  assert.deepEqual(r.songs[0], { line: 'Pavement - Gold Soundz', artist: 'Pavement', title: 'Gold Soundz', swappable: true, videoId: null });
});

test('numbering, bullets, timestamps and headers come off a pasted list', () => {
  const r = intake.parseIntake([
    'Setlist:',
    '1. Random Rules - Silver Jews',
    '02) Purple Mountains – All My Happiness Is Gone',
    '• Tennessee',
    '0:00 Pavement - Cut Your Hair',
    '3:45 - Wilco - Jesus, Etc. (4:12)',
    'Encore:',
    '',
    'Random Rules - Silver Jews',
  ].join('\n'));
  assert.equal(r.kind, 'songs');
  assert.deepEqual(r.songs.map((s) => s.line), [
    'Random Rules - Silver Jews',
    'Purple Mountains – All My Happiness Is Gone',
    'Tennessee',
    'Pavement - Cut Your Hair',
    'Wilco - Jesus, Etc.',
  ], 'headers dropped, duplicates dropped, numbering and times stripped');
});

test('a title that starts with a number keeps it', () => {
  assert.equal(intake.cleanLine('99 Problems'), '99 Problems');
  assert.equal(intake.cleanLine('7. 99 Problems'), '99 Problems');
});

test('"by" is read as Title by Artist, and the whole line is still tried as a title', () => {
  const song = intake.songFromLine('Stand by Me');
  assert.deepEqual(song, { line: 'Stand by Me', artist: 'Me', title: 'Stand', swappable: false, videoId: null });
  assert.deepEqual(intake.songCandidates(song), [
    { artist: 'Me', title: 'Stand' },
    { title: 'Stand by Me' },
  ]);
});

test('a hyphenated line is tried both ways round', () => {
  const song = intake.songFromLine('Gold Soundz - Pavement');
  assert.deepEqual(intake.songCandidates(song), [
    { artist: 'Gold Soundz', title: 'Pavement' },
    { artist: 'Pavement', title: 'Gold Soundz' },
    { title: 'Gold Soundz - Pavement' },
  ]);
});

test('a list of video links becomes a list of songs', () => {
  const r = intake.parseIntake('https://youtu.be/dQw4w9WgXcQ\nhttps://youtu.be/aaaaaaaaaaa\nhttps://youtu.be/dQw4w9WgXcQ');
  assert.equal(r.kind, 'songs');
  assert.deepEqual(r.songs.map((s) => s.videoId), ['dQw4w9WgXcQ', 'aaaaaaaaaaa']);
});

test('other services\' links are named as unsupported rather than searched for', () => {
  assert.deepEqual(intake.parseIntake('https://open.spotify.com/playlist/37i9dQZF1DX'),
    { kind: 'empty', reason: 'unsupported-link' });
  assert.deepEqual(intake.parseIntake('   \n  '), { kind: 'empty', reason: 'nothing' });
});

test('pairs read off a screenshot are cleaned and deduped', () => {
  assert.deepEqual(intake.songsFromPairs([
    { artist: 'Silver Jews', title: '1. Random Rules' },
    { artist: '', title: 'Tennessee' },
    { artist: 'Silver Jews', title: 'Random Rules' },
    { artist: 'X', title: '   ' },
  ]), [
    { line: 'Silver Jews - Random Rules', artist: 'Silver Jews', title: 'Random Rules', swappable: false, videoId: null },
    { line: 'Tennessee', artist: null, title: 'Tennessee', swappable: false, videoId: null },
  ]);
});
