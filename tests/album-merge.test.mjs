// @suite Album merge planning
// @area Import
// @covers src/lib/album-merge.ts planAlbumMerge albumNameKey
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './_load.mjs';

const { albumNameKey, planAlbumMerge } = loadTs('src/lib/album-merge.ts');

test('albumNameKey folds ampersands and punctuation like the importer', () => {
  assert.equal(albumNameKey('Bubble & Scrape'), albumNameKey('Bubble and Scrape'));
  assert.equal(albumNameKey('11:11'), '1111');
});

test('matching songs keep the older row and drop the newer', () => {
  const keep = [
    { id: 'k1', name: 'Old Friends', track_number: 1, created_at: '2026-01-01T00:00:00Z' },
  ];
  const drop = [
    { id: 'd1', name: 'Old Friends', track_number: 1, created_at: '2026-09-18T00:00:00Z' },
  ];
  assert.deepEqual(planAlbumMerge(keep, drop), [
    { kind: 'delete_drop', dropId: 'd1' },
  ]);
});

test('older drop song replaces newer keep song and takes its number', () => {
  const keep = [
    { id: 'k1', name: 'Cadmium', track_number: 2, created_at: '2026-09-18T00:00:00Z' },
  ];
  const drop = [
    { id: 'd1', name: 'Cadmium', track_number: 2, created_at: '2026-01-01T00:00:00Z' },
  ];
  assert.deepEqual(planAlbumMerge(keep, drop), [
    { kind: 'move_drop_delete_keep', keepId: 'k1', dropId: 'd1', trackNumber: 2 },
  ]);
});

test('unmatched drop songs append after the keep album', () => {
  const keep = [
    { id: 'k1', name: 'A', track_number: 1, created_at: '2026-01-01T00:00:00Z' },
    { id: 'k2', name: 'B', track_number: 3, created_at: '2026-01-01T00:00:00Z' },
  ];
  const drop = [
    { id: 'd1', name: 'Extra', track_number: 1, created_at: '2026-09-18T00:00:00Z' },
  ];
  assert.deepEqual(planAlbumMerge(keep, drop), [
    { kind: 'move_drop', dropId: 'd1', trackNumber: 4 },
  ]);
});
