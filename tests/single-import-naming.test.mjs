// @suite Reading a YouTube upload as a record
// @area Import
// @covers src/lib/single-import.ts, mjReadArtist() in public/index.html
//
// Add a song shows the artist name BEFORE it lands, so a bad guess can be
// corrected. That means two copies of the same rule: readArtistAndTitle on the
// server and mjReadArtist in the dashboard. The name on screen has to be the
// name that gets stored, so these run both over the same uploads and demand the
// same answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, loadHtmlFns, adminAuthStub } from './_load.mjs';

const { readArtistAndTitle, slugify, SINGLES_ALBUM } = loadTs('src/lib/single-import.ts', {
  'sj-admin-auth': adminAuthStub,
  'album-match': { lookupAlbumForTrack: async () => null },
  lrclib: { lrclibLookup: async () => null, plainFrom: () => null },
  'track-videos': { recordTrackVideo: async () => {}, thumbFor: () => null },
});

const { mjReadArtist } = loadHtmlFns(['mjReadArtist']);

/** Uploads in the shapes they really arrive in. */
const UPLOADS = [
  ['Random Rules', 'Silver Jews - Topic'],
  ['Silver Jews - Random Rules', 'Silver Jews - Topic'],
  ['Pavement - Gold Soundz (Official Video)', 'Matador Records'],
  ['Sebadoh — Brand New Love [Official Audio]', 'Sub Pop'],
  ['Walking The Cow  HQ', 'Daniel Johnston'],
  ['Bill Callahan - Jim Cain - Official Video', 'Drag City'],
  ['Untitled', ''],
  ['', 'Some Channel'],
  ['   ', '   '],
  ['Purple Mountains - All My Happiness is Gone (Official Music Video)', 'Drag City'],
  ['Big Star – Thirteen', 'Ardent'],
  ['A Very Long Band Name That Goes On And On And On Past Any Reasonable Length Whatsoever - Song', 'Chan'],
];

test('the server and the dashboard read every upload shape the same way', () => {
  for (const [title, channel] of UPLOADS) {
    assert.deepStrictEqual(
      mjReadArtist(title, channel),
      readArtistAndTitle(title, channel),
      'client and server disagree on "' + title + '" / "' + channel + '"',
    );
  }
});

test('a Topic channel is YouTube saying who the artist is, so it wins', () => {
  assert.deepStrictEqual(readArtistAndTitle('Random Rules', 'Silver Jews - Topic'), {
    artistName: 'Silver Jews',
    trackName: 'Random Rules',
  });
});

test('a Topic upload that repeats the band name does not store it twice', () => {
  assert.deepStrictEqual(readArtistAndTitle('Silver Jews - Random Rules', 'Silver Jews - Topic'), {
    artistName: 'Silver Jews',
    trackName: 'Random Rules',
  });
});

test('an Artist - Title upload splits, and the promotional noise comes off', () => {
  assert.deepStrictEqual(readArtistAndTitle('Pavement - Gold Soundz (Official Video)', 'Matador'), {
    artistName: 'Pavement',
    trackName: 'Gold Soundz',
  });
  assert.deepStrictEqual(readArtistAndTitle('Sebadoh — Brand New Love [Official Audio]', 'Sub Pop'), {
    artistName: 'Sebadoh',
    trackName: 'Brand New Love',
  });
});

test('a title with no separator is left whole and the channel supplies the artist', () => {
  // Half-guessing a band name is worse than saying the channel's.
  assert.deepStrictEqual(readArtistAndTitle('Walking The Cow  HQ', 'Daniel Johnston'), {
    artistName: 'Daniel Johnston',
    // Doubled spaces collapse, but a bare "HQ" is left alone: it is only noise
    // inside brackets, and stripping loose words out of a song title is how a
    // real name gets eaten.
    trackName: 'Walking The Cow HQ',
  });
  assert.deepStrictEqual(readArtistAndTitle('Walking The Cow (HQ)', 'Daniel Johnston'), {
    artistName: 'Daniel Johnston',
    trackName: 'Walking The Cow',
  });
});

test('an upload that names nobody still produces something storable', () => {
  assert.deepStrictEqual(readArtistAndTitle('', ''), {
    artistName: 'Unknown artist',
    trackName: 'Untitled',
  });
});

test('an implausibly long first half is not treated as a band name', () => {
  const long = 'x'.repeat(120) + ' - Song';
  const read = readArtistAndTitle(long, 'Some Channel');
  assert.equal(read.artistName, 'Some Channel');
});

test('slugify folds an ampersand to a word rather than dropping it', () => {
  assert.equal(slugify('Bubble & Scrape'), 'bubble-and-scrape');
  assert.equal(slugify('Guided By Voices'), 'guided-by-voices');
  assert.equal(slugify('Sigur Rós'), 'sigur-ros');
  assert.equal(slugify('!!!'), 'artist', 'a slug is never empty');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
});

test('every single by one artist lands in one album so they group into a card', () => {
  assert.equal(SINGLES_ALBUM, 'Singles');
});
