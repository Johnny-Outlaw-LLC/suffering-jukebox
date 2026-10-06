// @suite Reserved slugs
// @area Navigation
// @covers RESERVED_SLUGS against the pages that actually exist
// A page missing from the list is read as a Listening Party playlist name and
// redirected home. /analytics went that way on 2026-10-05.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { loadTs } from './_load.mjs';

const { RESERVED_SLUGS } = loadTs('src/lib/jukebox.ts');

test('every top-level page is reserved, so no playlist or artist can shadow it', () => {
  const pages = readdirSync(new URL('../src/app/', import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(d.name))
    .map((d) => d.name);
  assert.ok(pages.includes('analytics') && pages.includes('artist-stats'));
  const missing = pages.filter((p) => !RESERVED_SLUGS.has(p));
  assert.deepEqual(missing, [], `add these to RESERVED_SLUGS in src/lib/jukebox.ts: ${missing.join(', ')}`);
});
