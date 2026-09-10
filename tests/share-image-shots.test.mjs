// @suite Share image shot lists
// @area Share images
// @covers public/index.html SJ_EXPORT_SHOTS, capture/capture.mjs ALL_SHOTS, src/lib/share-images.ts
//
// Adding a jukebox view means three edits in three files, matched by shot_id
// and nothing else. When they disagree the app does not error: the export modal
// offers a picture the nightly job never built, so it silently falls through to
// drawing in a hidden iframe - slow on a desktop, broken on a phone. That is
// exactly what happened to Timeline / Tracks Open, By Views / Tracks Open and
// Albums List on 2026-08-23. This is the guard against the next one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, readRepoFile, htmlSlice } from './_load.mjs';

const shareImages = loadTs('src/lib/share-images.ts', {
  '@/lib/site': { SITE_URL: '' },
});

/** Read the ids out of an `[{ id: '...', ... }]` literal. */
function shotIds(body, where) {
  const ids = [...body.matchAll(/\bid:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]);
  assert.ok(ids.length, 'found no shot ids in ' + where);
  return ids;
}

function sliceArray(source, declaration) {
  const at = source.indexOf(declaration);
  assert.ok(at >= 0, 'could not find ' + declaration);
  const end = source.indexOf('];', at);
  assert.ok(end > at, declaration + ' is not a closed array literal');
  return source.slice(at, end);
}

const modalShots = shotIds(htmlSlice('const SJ_EXPORT_SHOTS = [', '];'), 'SJ_EXPORT_SHOTS');
const captureShots = shotIds(
  sliceArray(readRepoFile('capture/capture.mjs'), 'const ALL_SHOTS = ['),
  'ALL_SHOTS',
);

test('the export modal offers exactly the pictures the nightly job builds', () => {
  assert.deepStrictEqual(
    [...modalShots].sort(),
    [...captureShots].sort(),
    'SJ_EXPORT_SHOTS and ALL_SHOTS disagree - anything the modal offers that the job does not build falls back to rendering on the device',
  );
});

test('the modal and the capture job list the views in the same order', () => {
  assert.deepStrictEqual(modalShots, captureShots);
});

test('every shot the job builds has a label for the public share pages', () => {
  for (const id of captureShots) {
    assert.ok(shareImages.SHOT_LABELS[id], id + ' has no entry in SHOT_LABELS');
  }
  assert.deepStrictEqual(
    Object.keys(shareImages.SHOT_LABELS).sort(),
    [...captureShots].sort(),
    'SHOT_LABELS has drifted from the shots that actually exist',
  );
});

test('SHOT_ORDER is a complete ordering of the same shots, with nothing repeated', () => {
  assert.deepStrictEqual([...shareImages.SHOT_ORDER].sort(), [...captureShots].sort());
  assert.equal(
    new Set(shareImages.SHOT_ORDER).size,
    shareImages.SHOT_ORDER.length,
    'a repeated id would render the same picture twice on /share',
  );
});

test('no shot id is listed twice in any of the three lists', () => {
  assert.equal(new Set(modalShots).size, modalShots.length);
  assert.equal(new Set(captureShots).size, captureShots.length);
});

test('a share image is served from our own domain, never from the bucket', () => {
  // The bucket is private and cannot be made public, and serving from our own
  // domain is better for search anyway: images are attributed to the domain
  // that serves them.
  const url = shareImages.shareImageUrl({ b2_key: 'share/silver-jews/byyear-collapsed.png' });
  assert.ok(url.startsWith('/share-image/'), 'got ' + url);
  assert.ok(!/backblaze|b2|amazonaws/i.test(url));
});
