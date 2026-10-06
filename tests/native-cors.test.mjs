import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
const capacitor = JSON.parse(readFileSync(new URL('../native/capacitor.config.json', import.meta.url), 'utf8'));
const dashboard = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('native bundle uses a hostname distinct from the live API origin', () => {
  assert.equal(capacitor.server.hostname, 'app.listeningparty.stream');
});

test('trusted hosted tools stay inside the native WebView', () => {
  assert.deepEqual(capacitor.server.allowNavigation, [
    'listeningparty.stream',
    '*.listeningparty.stream',
    'sufferingjukebox.stream',
    '*.sufferingjukebox.stream',
  ]);
  assert.match(dashboard, /openHostedToolInNewTab\('\/analytics'\)/);
  assert.match(dashboard, /openHostedToolInNewTab\('\/artist-stats\?artist=' \+/);
  assert.match(dashboard, /if \(sjIsNative\(\)\) \{\s*await sjOpenHostedTool\(path\);/);
  assert.match(dashboard, /sjOpenHostedTool\('\/artist-discography-upload'\)/);
  assert.match(dashboard, /fromNativeApp: true/);
});

test('API CORS admits both native apps and handles preflight dynamically', () => {
  assert.match(proxy, /capacitor:\/\/www\.sufferingjukebox\.stream/);
  assert.match(proxy, /https:\/\/app\.listeningparty\.stream/);
  assert.match(proxy, /https:\/\/app\.recordkeeper\.stream/);
  assert.match(proxy, /request\.method === "OPTIONS"/);
  assert.match(proxy, /Access-Control-Allow-Origin/);
  assert.doesNotMatch(config, /const NATIVE_ORIGIN/);
});

test('Listening Party can frame the player route without a playlist rewrite', () => {
  const jukebox = readFileSync(new URL('../src/lib/jukebox.ts', import.meta.url), 'utf8');
  assert.match(jukebox, /"yt-frame"/);
  assert.match(config, /frame-ancestors[^\n]+https:\/\/app\.listeningparty\.stream/);
  assert.match(config, /frame-ancestors[^\n]+https:\/\/app\.recordkeeper\.stream/);
});

test('playlist creation sends intake and signed-in library requests to the live API', () => {
  assert.match(
    dashboard,
    /async function admPost[\s\S]*?nativeHttp\.post\(\{/,
    'Create a Playlist intake must use native HTTP on iOS',
  );
  assert.match(
    dashboard,
    /async function mjRequest[\s\S]*?nativeHttp\.request\(\{/,
    'playlist search and save must use native HTTP on iOS',
  );
});

test('native playlist intake bypasses WKWebView fetch and keeps authentication', async () => {
  let request;
  const scope = {
    googleUser: { email: 'listener@example.com' },
    _sjjToken: async () => 'signed-token',
    sjApiUrl: path => 'https://listeningparty.stream' + path,
    sjIsNative: () => true,
    sjFetch: () => { throw new Error('WKWebView fetch should not run'); },
    window: { Capacitor: { Plugins: { CapacitorHttp: { post: async options => {
      request = options;
      return { status: 200, data: { ok: true, kind: 'query', query: 'Pink Floyd' } };
    } } } } },
  };
  const { admPost } = loadHtmlFnsInScope(['admPost'], scope);
  const result = await admPost('/api/import/intake', { text: 'Pink Floyd' });
  assert.equal(request.url, 'https://listeningparty.stream/api/import/intake');
  assert.equal(request.headers.Authorization, 'Bearer signed-token');
  assert.deepEqual(request.data, { text: 'Pink Floyd' });
  assert.equal(result.query, 'Pink Floyd');
});

test('native catalogue reads bypass WKWebView fetch and preserve PostgREST headers', async () => {
  let request;
  const scope = {
    SJ_FETCH_TIMEOUT_MS: 45000,
    sjIsNative: () => true,
    sjFetch: () => { throw new Error('WKWebView fetch should not run'); },
    window: { Capacitor: { Plugins: { CapacitorHttp: { get: async options => {
      request = options;
      return { status: 200, data: '[{"id":"track-1"}]' };
    } } } } },
  };
  const { sjGetJson } = loadHtmlFnsInScope(['sjGetJson'], scope);
  const headers = {
    apikey: 'public-key',
    Authorization: 'Bearer public-key',
    'Accept-Profile': 'jukebox',
  };
  const result = await sjGetJson(
    'https://example.supabase.co/rest/v1/tracks?id=in.(track-1)',
    headers,
  );
  assert.equal(request.url, 'https://example.supabase.co/rest/v1/tracks?id=in.(track-1)');
  assert.deepEqual(request.headers, headers);
  assert.equal(request.responseType, 'json');
  assert.equal(request.connectTimeout, 45000);
  assert.equal(request.readTimeout, 45000);
  assert.deepEqual(result, [{ id: 'track-1' }]);
});

test('playlist hydration uses the native-safe catalogue reader at every metadata stage', () => {
  assert.match(dashboard, /const dbGet = async \(path\) => \{[\s\S]*?sjGetJson/);
  assert.match(dashboard, /const dbGetAuth = async \(path\) => \{[\s\S]*?sjGetJson/);
  assert.match(dashboard, /async function openPlaylistChart[\s\S]*?dbGet\(`\/tracks[\s\S]*?dbGet\(`\/albums[\s\S]*?dbGet\(`\/artists[\s\S]*?loadYT\(ids\)/);
});

test('native background-audio signing uses the same native-safe GET transport', () => {
  assert.match(dashboard, /async function taOwnAudioUrls[\s\S]*?sjGetJson\([\s\S]*?\/api\/sj-audio/);
  assert.match(dashboard, /async function loadTrackAudio[\s\S]*?sjGetJson\([\s\S]*?\/api\/sj-artist-audio\?purpose=mobile-background/);
  assert.match(dashboard, /if \(playlistId === '__dynamic_background'\) await loadTrackAudio\(ids\)/);
  assert.match(dashboard, /item\.artistAudio = true/);
});
