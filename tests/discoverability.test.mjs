// @suite Discoverability
// @area Platform
// @covers src/lib/llms-txt.ts
// @covers src/app/llms.txt/route.ts
// @covers src/app/sitemap.ts
// @covers src/app/robots.ts
//
// Search and AI crawlers find these sites through robots.txt, sitemap.xml and
// llms.txt. A static public/llms.txt once made Listening Party advertise
// Suffering Jukebox; these checks pin the surface-aware shape so that cannot
// quietly come back.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadTs, readRepoFile } from './_load.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const surfaceMod = loadTs('src/lib/surface.ts');
const { SURFACES } = surfaceMod;
const llms = loadTs('src/lib/llms-txt.ts', { 'lib/surface': surfaceMod });

function urlsOf(entries) {
  return entries.map((e) => e.url);
}

function loadSitemapFor(surface) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return [];
    },
  });
  try {
    const mod = loadTs('src/app/sitemap.ts', {
      'lib/surface': { ...surfaceMod, currentSurface: () => surface },
      'lib/share-images': {
        shareImageUrl: (row) => `https://cdn.example/${row.b2_key || 'x'}`,
      },
    });
    return mod.default();
  } finally {
    globalThis.fetch = prevFetch;
  }
}

function loadRobotsFor(surface) {
  const mod = loadTs('src/app/robots.ts', {
    'lib/surface': { ...surfaceMod, currentSurface: () => surface },
  });
  return mod.default();
}

test('there is no static public/llms.txt (it would leak one brand onto both hosts)', () => {
  assert.equal(
    existsSync(join(root, 'public', 'llms.txt')),
    false,
    'public/llms.txt must stay deleted; the route owns brand copy',
  );
  assert.equal(existsSync(join(root, 'src', 'app', 'llms.txt', 'route.ts')), true);
});

test('Suffering Jukebox llms.txt names the jukebox and points at artist pages', () => {
  const text = llms.buildLlmsTxt(SURFACES.sj);
  assert.match(text, /^# Suffering Jukebox/m);
  assert.match(text, /sufferingjukebox\.stream/);
  assert.match(text, /\/silver-jews/);
  assert.match(text, /\/sitemap\.xml/);
  assert.match(text, /listeningparty\.stream/);
  assert.doesNotMatch(text, /^# Listening Party/m);
});

test('Listening Party llms.txt is playlist-shaped and does not sell the jukebox', () => {
  const text = llms.buildLlmsTxt(SURFACES.lp);
  assert.match(text, /^# Listening Party/m);
  assert.match(text, /listeningparty\.stream/);
  assert.match(text, /\/p\/\{slug\}/);
  assert.match(text, /\/sitemap\.xml/);
  assert.doesNotMatch(text, /170\+ artists/);
  assert.doesNotMatch(text, /\/silver-jews/);
  assert.doesNotMatch(text, /^# Suffering Jukebox/m);
});

test('Suffering Jukebox sitemap lists llms.txt and artist-shaped shells', async () => {
  const entries = await loadSitemapFor(SURFACES.sj);
  const urls = urlsOf(entries);
  assert.ok(urls.includes(`${SURFACES.sj.url}/llms.txt`));
  assert.ok(urls.includes(`${SURFACES.sj.url}/about`));
  assert.ok(urls.includes(`${SURFACES.sj.url}/community`));
  assert.ok(urls.includes(`${SURFACES.sj.url}/share`));
  assert.ok(urls.every((u) => u.startsWith(SURFACES.sj.url)));
});

test('Listening Party sitemap lists llms.txt and skips artist shells', async () => {
  const entries = await loadSitemapFor(SURFACES.lp);
  const urls = urlsOf(entries);
  assert.ok(urls.includes(`${SURFACES.lp.url}/llms.txt`));
  assert.ok(urls.includes(`${SURFACES.lp.url}/about`));
  assert.ok(!urls.includes(`${SURFACES.lp.url}/community`));
  assert.ok(!urls.includes(`${SURFACES.lp.url}/share`));
  assert.ok(urls.every((u) => u.startsWith(SURFACES.lp.url)));
});

test('robots.txt points each brand at its own sitemap and blocks foreign shells on LP', () => {
  const sj = loadRobotsFor(SURFACES.sj);
  assert.equal(sj.sitemap, `${SURFACES.sj.url}/sitemap.xml`);
  assert.equal(sj.host, SURFACES.sj.url);
  assert.ok(!sj.rules.disallow.includes('/share'));
  assert.ok(!sj.rules.disallow.includes('/community'));

  const lp = loadRobotsFor(SURFACES.lp);
  assert.equal(lp.sitemap, `${SURFACES.lp.url}/sitemap.xml`);
  assert.equal(lp.host, SURFACES.lp.url);
  assert.ok(lp.rules.disallow.includes('/share'));
  assert.ok(lp.rules.disallow.includes('/community'));
});

test('llms route wires host resolution through buildLlmsTxt', () => {
  const src = readRepoFile('src/app/llms.txt/route.ts');
  assert.match(src, /buildLlmsTxt/);
  assert.match(src, /currentSurface\(req\.headers\.get\("host"\)\)/);
  assert.match(src, /text\/plain/);
});
