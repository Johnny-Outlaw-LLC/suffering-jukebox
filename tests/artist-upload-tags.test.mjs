// @suite Reading an artist's files before they upload
// @area Artist Upload
// @covers src/lib/audio-tags.ts parseId3 parseFlac guessFromFileName planReleases
// The artist upload page prefills every release from the files themselves:
// album, artist, year, track order and the embedded cover. A tag reader that
// quietly returns nothing looks exactly like a folder with no tags, so these
// build real ID3 and FLAC headers byte by byte and read them back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/audio-tags.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const exports = {};
vm.runInNewContext(js, { exports, TextDecoder, DataView, Uint8Array, Number, Map, Set, String, Math });
const { parseId3, parseFlac, parseId3v1, guessFromFileName, planReleases, isAudioFileName, isCoverFileName } = exports;

const enc = new TextEncoder();
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const be32 = (n) => new Uint8Array([n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]);
const le32 = (n) => new Uint8Array([n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255]);
const syncsafe = (n) => new Uint8Array([n >> 21 & 127, n >> 14 & 127, n >> 7 & 127, n & 127]);

function id3v23(frames) {
  const body = cat(...frames.map(([id, data]) => cat(enc.encode(id), be32(data.length), new Uint8Array(2), data)));
  return cat(enc.encode('ID3'), new Uint8Array([3, 0, 0]), syncsafe(body.length), body);
}
const textFrame = (s) => cat(new Uint8Array([3]), enc.encode(s));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

test('ID3v2.3 gives title, artist, album, year, track and the cover', () => {
  const apic = cat(new Uint8Array([0]), enc.encode('image/jpeg'), new Uint8Array([0, 3]), enc.encode('front'), new Uint8Array([0]), JPEG);
  const tags = parseId3(id3v23([
    ['TIT2', textFrame('Random Rules')], ['TPE1', textFrame('Silver Jews')], ['TALB', textFrame('American Water')],
    ['TYER', textFrame('1998')], ['TRCK', textFrame('1/12')], ['APIC', apic],
  ]));
  assert.equal(tags.title, 'Random Rules');
  assert.equal(tags.artist, 'Silver Jews');
  assert.equal(tags.album, 'American Water');
  assert.equal(tags.year, '1998');
  assert.equal(tags.track, 1);
  assert.equal(tags.picture.mime, 'image/jpeg');
  assert.deepEqual([...tags.picture.bytes], [...JPEG]);
});

test('ID3v2.4 TDRC holds a full date and still yields the year', () => {
  const tag = id3v23([['TDRC', textFrame('2019-07-12')], ['TIT2', textFrame('Margaritas at the Mall')]]);
  tag[3] = 4; // the frame sizes above are under 128, so syncsafe and plain agree
  assert.equal(parseId3(tag).year, '2019');
});

test('FLAC Vorbis comments and the picture block', () => {
  const comments = ['TITLE=Darkness', 'ARTIST=Purple Mountains', 'ALBUM=Purple Mountains', 'DATE=2019', 'TRACKNUMBER=4'];
  const vorbis = cat(le32(0), le32(comments.length), ...comments.map((c) => cat(le32(enc.encode(c).length), enc.encode(c))));
  const mime = enc.encode('image/png');
  const picture = cat(be32(3), be32(mime.length), mime, be32(0), new Uint8Array(16), be32(JPEG.length), JPEG);
  const block = (type, data, last) => cat(new Uint8Array([(last ? 0x80 : 0) | type, data.length >> 16 & 255, data.length >> 8 & 255, data.length & 255]), data);
  const tags = parseFlac(cat(enc.encode('fLaC'), block(0, new Uint8Array(34)), block(4, vorbis), block(6, picture, true)));
  assert.equal(tags.title, 'Darkness');
  assert.equal(tags.artist, 'Purple Mountains');
  assert.equal(tags.year, '2019');
  assert.equal(tags.track, 4);
  assert.equal(tags.picture.mime, 'image/png');
  assert.equal(tags.picture.bytes.length, JPEG.length);
});

test('ID3v1.1 carries a track number in the comment', () => {
  const b = new Uint8Array(128);
  b.set(enc.encode('TAG'), 0);
  b.set(enc.encode('Trains Across the Sea'), 3);
  b.set(enc.encode('Silver Jews'), 33);
  b.set(enc.encode('Starlite Walker'), 63);
  b.set(enc.encode('1994'), 93);
  b[126] = 2;
  const tags = parseId3v1(b);
  assert.equal(tags.title, 'Trains Across the Sea');
  assert.equal(tags.track, 2);
  assert.equal(tags.year, '1994');
});

test('file names give a track number only when they clearly mean one', () => {
  assert.deepEqual({ ...guessFromFileName('03 - Smith & Jones Forever.wav') }, { title: 'Smith & Jones Forever', track: 3 });
  assert.deepEqual({ ...guessFromFileName('1-07 Pet Politics.flac') }, { title: 'Pet Politics', track: 7 });
  assert.deepEqual({ ...guessFromFileName('04. Tennessee.mp3') }, { title: 'Tennessee', track: 4 });
  assert.deepEqual({ ...guessFromFileName('09 Black and Brown Blues.mp3') }, { title: 'Black and Brown Blues', track: 9 });
  assert.equal(guessFromFileName('99 Problems.mp3').title, '99 Problems');
  assert.equal(guessFromFileName('Song - Live.mp3').title, 'Song - Live');
});

test('a dropped discography splits into releases by album tag, then folder', () => {
  const t = (album, title, track, year) => ({ album, title, track, year, artist: 'Silver Jews' });
  const releases = JSON.parse(JSON.stringify(planReleases([
    { path: 'SJ/American Water/02 Smith.mp3', size: 1, tags: t('American Water', 'Smith & Jones Forever', 2, '1998') },
    { path: 'SJ/American Water/01 Random.mp3', size: 1, tags: t('American Water', 'Random Rules', 1, '1998') },
    { path: 'SJ/Starlite Walker/a.mp3', size: 1, tags: t('Starlite Walker', 'Trains Across the Sea', 1, '1994') },
    { path: 'SJ/Demos/03 later.wav', size: 1, tags: null },
    { path: 'SJ/Demos/01 first.wav', size: 1, tags: null },
  ])));
  assert.deepEqual(releases.map((r) => r.title), ['Starlite Walker', 'American Water', 'Demos']);
  const water = releases.find((r) => r.title === 'American Water');
  assert.equal(water.artist, 'Silver Jews');
  assert.equal(water.year, '1998');
  assert.deepEqual(water.tracks.map((x) => [x.number, x.title]), [[1, 'Random Rules'], [2, 'Smith & Jones Forever']]);
  const demos = releases.find((r) => r.title === 'Demos');
  assert.deepEqual(demos.tracks.map((x) => x.title), ['first', 'later']);
});

test('only audio and cover files are picked out of a folder', () => {
  assert.ok(isAudioFileName('song.FLAC'));
  assert.ok(!isAudioFileName('take.aiff')); // browsers cannot play it, and nothing transcodes
  assert.ok(!isAudioFileName('notes.txt'));
  assert.ok(isCoverFileName('Album/cover.jpg'));
  assert.ok(isCoverFileName('folder.PNG'));
  assert.ok(!isCoverFileName('band-photo.jpg'));
});
