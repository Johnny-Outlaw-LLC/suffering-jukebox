// @suite Reading tags off an audio file
// @area Audio storage
// @covers taReadId3 and the path guesser in public/index.html
// Pulls the ID3 reader and path guesser straight out of the dashboard HTML and
// runs them against synthetic files, because a tag parser that quietly returns
// null looks exactly like a folder of untagged music.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// One contiguous span, taCleanTag through taFileMeta, evaluated on its own.
const from = html.indexOf('function taCleanTag(');
const to = html.indexOf('async function taBatchAddFolderFiles(');
assert.ok(from > 0 && to > from, 'could not locate the tag-reading block');
const block = html.slice(from, to);

const sandbox = { TA_ID3_MAX_BYTES: 3 * 1024 * 1024, TextDecoder, Uint8Array, Number, Math, console };
vm.createContext(sandbox);
vm.runInContext(block + '\nglobalThis.__api = { taReadId3, taReadId3v1, taGuessFromPath, taFileMeta };', sandbox);
const { taReadId3, taReadId3v1, taGuessFromPath, taFileMeta } = sandbox.__api;

const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

/** A minimal but real ID3v2.3 tag: latin-1 text frames, plain 32-bit sizes. */
function id3v23(frames) {
  const parts = [];
  for (const [id, value] of Object.entries(frames)) {
    const body = [0, ...Buffer.from(value, 'latin1')];
    parts.push(Buffer.from([
      ...Buffer.from(id, 'ascii'),
      (body.length >> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff,
      0, 0, ...body,
    ]));
  }
  const payload = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(payload.length)]), payload]);
}

/** v2.4 differs in two ways that matter: syncsafe frame sizes and UTF-8 text. */
function id3v24(frames) {
  const parts = [];
  for (const [id, value] of Object.entries(frames)) {
    const body = [3, ...Buffer.from(value, 'utf8')];
    parts.push(Buffer.from([...Buffer.from(id, 'ascii'), ...syncsafe(body.length), 0, 0, ...body]));
  }
  const payload = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe(payload.length)]), payload]);
}

function id3v1({ title, artist, album }) {
  const pad = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(30)]).subarray(0, 30);
  return Buffer.concat([Buffer.from('TAG', 'ascii'), pad(title), pad(artist), pad(album), Buffer.alloc(35)]);
}

const fileOf = (buf, name, relPath) => {
  const f = new File([buf], name);
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath ?? '' });
  return f;
};
const audio = Buffer.alloc(4096, 0x55);

test('reads an ID3v2.3 tag', async () => {
  const buf = Buffer.concat([id3v23({ TIT2: 'Random Rules', TPE1: 'Silver Jews', TALB: 'American Water', TLEN: '223000' }), audio]);
  const tag = await taReadId3(fileOf(buf, '01.mp3'));
  assert.deepEqual(
    { title: tag.title, artist: tag.artist, album: tag.album, lengthMs: tag.lengthMs },
    { title: 'Random Rules', artist: 'Silver Jews', album: 'American Water', lengthMs: '223000' },
  );
});

test('reads an ID3v2.4 tag, syncsafe sizes and UTF-8 and all', async () => {
  const buf = Buffer.concat([id3v24({ TIT2: 'Trains Across the Sea', TPE1: 'Silver Jews' }), audio]);
  const tag = await taReadId3(fileOf(buf, 'x.mp3'));
  assert.equal(tag.title, 'Trains Across the Sea');
  assert.equal(tag.artist, 'Silver Jews');
});

test('falls back to the 128 bytes on the end of an old rip', async () => {
  const buf = Buffer.concat([audio, id3v1({ title: 'Punks in the Beerlight', artist: 'Silver Jews', album: 'Tanglewood Numbers' })]);
  assert.equal(await taReadId3(fileOf(buf, 'x.mp3')), null);
  const tag = await taReadId3v1(fileOf(buf, 'x.mp3'));
  assert.equal(tag.title, 'Punks in the Beerlight');
  assert.equal(tag.artist, 'Silver Jews');
});

test('an untagged file falls back to Artist/Album/01 Title.mp3', async () => {
  const meta = await taFileMeta(fileOf(audio, '03 Smith & Jones Forever.mp3', 'Music/Silver Jews/American Water/03 Smith & Jones Forever.mp3'));
  assert.deepEqual(
    { title: meta.title, artist: meta.artist, album: meta.album },
    { title: 'Smith & Jones Forever', artist: 'Silver Jews', album: 'American Water' },
  );
});

test('"Artist - Title" in the filename beats the folder above it', () => {
  const g = taGuessFromPath(fileOf(audio, '07 Bill Callahan - Jim Cain.mp3', 'Mixes/Best of 2009/07 Bill Callahan - Jim Cain.mp3'));
  assert.equal(g.title, 'Jim Cain');
  assert.equal(g.artist, 'Bill Callahan');
});

test('a tag beats the folder it sits in', async () => {
  const buf = Buffer.concat([id3v23({ TIT2: 'Death of an Heir of Sorrows', TPE1: 'Silver Jews' }), audio]);
  const meta = await taFileMeta(fileOf(buf, '10 track.mp3', 'Rips/Unknown Artist/Unknown Album/10 track.mp3'));
  assert.equal(meta.title, 'Death of an Heir of Sorrows');
  assert.equal(meta.artist, 'Silver Jews');
});

test('a file with no tag and no folder still yields its own name', async () => {
  const meta = await taFileMeta(fileOf(audio, '05. Horseleg Swastikas.mp3'));
  assert.equal(meta.title, 'Horseleg Swastikas');
  assert.equal(meta.durationSeconds, null);
});
