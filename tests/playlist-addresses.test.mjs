import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboard = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
const playlistRoute = readFileSync(new URL('../src/app/p/[slug]/route.ts', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../src/app/sitemap.ts', import.meta.url), 'utf8');

test('playlist views use root slugs on Listening Party and prefixed slugs on Suffering Jukebox', () => {
  assert.match(dashboard, /const prefix = SJ_BRAND\.features\.artistPages \? '\/p\/' : '\/'/);
  assert.match(playlistRoute, /surface\.features\.artistPages\s*\? `\$\{surface\.url\}\/p\/\$\{seoPl\.slug\}`\s*:\s*`\$\{surface\.url\}\/\$\{seoPl\.slug\}`/);
  assert.match(sitemap, /surface\.features\.artistPages\s*\? `\$\{SITE_URL\}\/p\/\$\{slug\}`\s*:\s*`\$\{SITE_URL\}\/\$\{slug\}`/);
});

test('Listening Party root playlist addresses are internally rewritten without replacing the visible URL', () => {
  assert.match(proxy, /currentSurface\(request\.headers\.get\("host"\)\)\.id === "lp"/);
  assert.match(proxy, /to\.pathname = `\/p\/\$\{slug\}`;\s*response = NextResponse\.rewrite\(to\)/);
});

test('opening a playlist updates its address before catalog hydration completes', () => {
  const open = dashboard.indexOf('async function openPlaylistChart(playlistId)');
  const push = dashboard.indexOf('void plEnsureShareUrl(p);', open);
  const fetch = dashboard.indexOf('const chunks = [];', open);
  assert.ok(open >= 0 && push > open && fetch > push);
});
