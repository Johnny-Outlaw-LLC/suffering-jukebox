import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');

test('API CORS admits both native apps and handles preflight dynamically', () => {
  assert.match(proxy, /capacitor:\/\/www\.sufferingjukebox\.stream/);
  assert.match(proxy, /https:\/\/app\.listeningparty\.stream/);
  assert.match(proxy, /request\.method === "OPTIONS"/);
  assert.match(proxy, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(config, /const NATIVE_ORIGIN/);
});

test('Listening Party can frame the player route without a playlist rewrite', () => {
  const jukebox = readFileSync(new URL('../src/lib/jukebox.ts', import.meta.url), 'utf8');
  assert.match(jukebox, /"yt-frame"/);
  assert.match(config, /frame-ancestors[^\n]+https:\/\/app\.listeningparty\.stream/);
});
