import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
function extract(name) {
  const start = html.indexOf('async function ' + name + '(');
  const end = html.indexOf('\n}', start) + 2;
  return html.slice(start, end);
}
function setup(extra = {}) {
  const pushed = [];
  const ctx = vm.createContext({
    _myVotesLoaded: false, _sjCarPlaylistsLoaded: false, _savedPlaylists: [], playlists: [], pubPlaylists: [],
    googleUser: { email: 'me@example.com' },
    sjGetSession: async () => ({ data: { session: { access_token: 'test' } } }),
    sjApiUrl: path => 'https://sufferingjukebox.stream' + path,
    dynamicPlaylistRows: () => [{ id: 'favorites', name: 'Favorites', _tracks: [{ track_id: 'fav' }] }],
    sjDlPlugin: () => ({ setPlaylists: async value => pushed.push(value) }),
    ...extra,
  });
  vm.runInContext(extract('sjCarPushPlaylists') + '\n' + extract('loadPlaylists'), ctx);
  return { ctx, pushed };
}
test('native playlist loading bypasses WebKit CORS through Capacitor HTTP', async () => {
  let requested;
  const { ctx } = setup({
    window: { Capacitor: { Plugins: { CapacitorHttp: { get: async request => {
      requested = request;
      return { status: 200, data: { ok: true, playlists: [
        { id: 'public', name: 'Public', is_public: true, user_email: 'other@example.com', _tracks: [] },
      ] } };
    } } } } },
    sjIsNative: () => true,
    fetch: async () => { throw new Error('native load must not use WebKit fetch'); },
  });
  await ctx.loadPlaylists();
  assert.equal(requested.url, 'https://sufferingjukebox.stream/api/playlist-share');
  assert.equal(ctx.pubPlaylists.length, 1);
});
test('saved playlists use live API and sync before JS download index is ready', async () => {
  const { ctx, pushed } = setup({ fetch: async url => {
    assert.equal(url, 'https://sufferingjukebox.stream/api/playlist-share');
    return { ok: true, json: async () => ({ ok: true, playlists: [
      { id: 'sj', name: 'Silver Jews + Pavement', _tracks: [{ track_id: 'b' }, { track_id: 'a' }] },
      { id: 'em', name: 'Essential Eminem', _tracks: [{ track_id: 'e' }] },
    ] }) };
  } });
  await ctx.loadPlaylists();
  assert.equal(pushed[0].playlists.length, 3);
  assert.equal(pushed[0].playlists[0].trackIds.join(','), 'b,a');
});
test('startup and failed fetch do not replace offline playlists with Favorites', async () => {
  const { ctx, pushed } = setup({ fetch: async () => { throw Error('offline'); } });
  await ctx.sjCarPushPlaylists();
  await ctx.loadPlaylists();
  assert.equal(pushed.length, 0);
});
test('Silver Jews artwork repair uses the same album override as the web', async () => {
  let tracks;
  const ctx = vm.createContext({
    console, ALBUM_ART: { 'American Water': 'https://covers.example/american-water.jpg' },
    sjDlPlugin: () => ({ backfillArtwork: async value => { tracks = value.tracks; return { repaired: 1 }; } }),
    dbGet: async path => path.startsWith('/tracks')
      ? [{ id: 'song', album_id: 'album' }]
      : [{ id: 'album', name: 'American Water', art_url: null }],
  });
  vm.runInContext(extract('sjDlBackfillArtwork'), ctx);
  await ctx.sjDlBackfillArtwork([{ trackId: 'song' }]);
  assert.equal(tracks[0].artworkUrl, 'https://covers.example/american-water.jpg');
});

test('Favorites sync even when saved playlists have not loaded', async () => {
  const { ctx, pushed } = setup({ _myVotesLoaded: true });
  await ctx.sjCarPushPlaylists();
  assert.equal(pushed[0].preserveSaved, true);
  assert.equal(pushed[0].preserveFavorites, false);
  assert.equal(pushed[0].playlists[0].trackIds.join(','), 'fav');
});
test('saved playlist refresh preserves Favorites until votes load', async () => {
  const { ctx, pushed } = setup({ _sjCarPlaylistsLoaded: true });
  await ctx.sjCarPushPlaylists();
  assert.equal(pushed[0].preserveFavorites, true);
});
test('play counts cross the native bridge without requiring downloads to load', async () => {
  let received;
  const ctx = vm.createContext({ inAppPlays: { a: 12, b: 3 },
    sjDlPlugin: () => ({ setPlayCounts: async value => { received = value; } }) });
  vm.runInContext(extract('sjCarPushPlayCounts'), ctx);
  await ctx.sjCarPushPlayCounts();
  assert.equal(received.counts.a, 12);
  assert.equal(received.counts.b, 3);
});

test('authentication lifecycle always has a stream-library refresh function', () => {
  assert.match(html, /function sjCarPushStreamLibrary\(\)/);
  assert.match(html, /async function sjCarRefreshLibrary\(\)/);
  assert.match(html, /function sjCarTrackIds\(\)/);
});

test('stream refresh keeps native track ids available to ratings and shuffle', async () => {
  const ctx = vm.createContext({
    _sjDownloads: new Map([['downloaded', 'done']]),
    sjCarPushShuffleProfile() {},
    sjCarSchedulePushRatings() {},
    sjDlPlugin: () => ({ refreshCarLibrary: async () => ({ trackIds: ['streamed', 'downloaded'] }) }),
    Set,
  });
  const trackIdsStart = html.indexOf('function sjCarTrackIds(');
  const trackIdsEnd = html.indexOf('\n}', trackIdsStart) + 2;
  vm.runInContext('let _sjCarStreamIds = [];\n' + extract('sjCarRefreshLibrary') + '\n' + html.slice(trackIdsStart, trackIdsEnd), ctx);
  await ctx.sjCarRefreshLibrary();
  assert.deepEqual(Array.from(ctx.sjCarTrackIds()).sort(), ['downloaded', 'streamed']);
});

test('native partial playlists include one available song and preserve running order', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('../ios/App/App/Audio/SJPlaylistStore.swift', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('    func playable()'), source.lastIndexOf('}'));
  const script = `
import Foundation
struct SJCarEntry { let trackId: String }
enum SJCarLibrary {
  static func entry(for id: String) -> SJCarEntry? { ["a", "b"].contains(id) ? SJCarEntry(trackId: id) : nil }
}
class Store {
  struct Playlist { let id: String; let trackIds: [String] }
  func all() -> [Playlist] { [
    Playlist(id: "plus", trackIds: ["b", "missing", "a"]),
    Playlist(id: "__dynamic_favorites", trackIds: ["missing", "a"]),
    Playlist(id: "unavailable", trackIds: ["missing"])
  ] }
${method}
}
let result = Store().playable()
assert(result.count == 2)
assert(result[0].playlist.id == "__dynamic_favorites")
assert(result[0].entries.map { $0.trackId } == ["a"])
assert(result[1].entries.map { $0.trackId } == ["b", "a"])
`;
  const result = spawnSync('swift', ['-'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Shuffle All starts a random available song with the entire queue and exits Repeat One', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('../ios/App/App/CarPlay/SJCarPlaySceneDelegate.swift', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('    private func shuffleItem('), source.indexOf('    private func listItems(')).replace('private func', 'func');
  const script = `
import Foundation
struct UIImage { init?(systemName: String) {} }
class CPListItem {
  var isEnabled = true
  var handler: ((CPListItem, () -> Void) -> Void)?
  init(text: String, detailText: String?) {}
  func setImage(_ image: UIImage?) {}
}
struct SJCarEntry { let trackId: String }
class SJShuffleProfile {
  static let shared = SJShuffleProfile()
  var isWeighted = true
  // Only one song carries any weight, so a weighted draw can only ever return
  // that one - which is what makes the assertion below mean something.
  func weight(for trackId: String) -> Double { trackId == "742" ? 1.0 : 0.0 }
}
class SJAudioEngine {
  enum Mode { case one, off }
  static let shared = SJAudioEngine()
  var repeatMode = Mode.one
  var shuffle = false
  func cycleRepeatMode() { repeatMode = .off }
  func setShuffle(_ value: Bool) { shuffle = value }
}
class Subject {
  var played: [SJCarEntry] = []
  var first: String?
  func songCount(_ n: Int) -> String { String(n) }
  func play(startingAt entry: SJCarEntry, in entries: [SJCarEntry], playlistId: String? = nil) {
    first = entry.trackId
    played = entries
  }
${method}
}
let subject = Subject()
let entries = (0..<1000).map { SJCarEntry(trackId: String($0)) }
let item = subject.shuffleItem(for: entries)
var completed = false
item.handler?(item, { completed = true })
assert(completed)
assert(subject.played.count == 1000)
assert(entries.contains { $0.trackId == subject.first })
// Shuffle All draws its first song against the listener's weights too, so the
// one song carrying any weight is the only one it can start on.
assert(subject.first == "742")
assert(SJAudioEngine.shared.shuffle)
assert(SJAudioEngine.shared.repeatMode == .off)
assert(!subject.shuffleItem(for: []).isEnabled)
`;
  const result = spawnSync('swift', ['-'], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the car key is issued through Capacitor HTTP, not a WebKit POST', async () => {
  const requests = [];
  const handed = [];
  const plugin = (status) => ({
    carAccessStatus: async () => status,
    setCarAccess: async value => handed.push(value),
  });
  const ctx = vm.createContext({
    console,
    googleUser: { email: 'me@example.com', name: 'Me' },
    SJ_FRAME_ORIGIN: 'https://www.listeningparty.stream',
    SJ_FETCH_TIMEOUT_MS: 1000,
    sjIsNative: () => true,
    sjApiUrl: path => 'https://www.listeningparty.stream' + path,
    sjAuthHeaders: async () => ({ Authorization: 'Bearer session' }),
    getDeviceId: () => 'device-123',
    fetch: async () => { throw new Error('Load failed'); },
    sjFetch: async () => { throw new Error('Load failed'); },
    window: { Capacitor: { Plugins: { CapacitorHttp: { request: async req => {
      requests.push(req);
      return { status: 200, data: { ok: true, key: 'k'.repeat(43), email: 'me@example.com', name: 'Johnny Outlaw' } };
    } } } } },
    sjDlPlugin: null,
  });
  vm.runInContext(extract('sjApiJson') + '\nlet _sjCarAccessBusy = false;\n' + extract('sjCarEnsureAccess'), ctx);

  // No key yet: one is issued natively and handed over with the account name.
  ctx.sjDlPlugin = () => plugin({ hasKey: false, email: null, keyAccepted: null });
  await ctx.sjCarEnsureAccess();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, 'https://www.listeningparty.stream/api/sj-carplay-key');
  assert.equal(requests[0].headers.Authorization, 'Bearer session');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].data)), { deviceId: 'device-123' });
  assert.equal(handed[0].name, 'Johnny Outlaw');

  // A working key for this account: nothing to do.
  ctx.sjDlPlugin = () => plugin({ hasKey: true, email: 'ME@example.com', keyAccepted: true });
  await ctx.sjCarEnsureAccess();
  assert.equal(requests.length, 1);

  // The server turned the held key down: replace it.
  ctx.sjDlPlugin = () => plugin({ hasKey: true, email: 'me@example.com', keyAccepted: false });
  await ctx.sjCarEnsureAccess();
  assert.equal(requests.length, 2);
});

test('the phone follows what CarPlay is playing, muted, and its buttons steer the car', async () => {
  const fn = name => {
    for (const head of ['async function ' + name + '(', 'function ' + name + '(']) {
      const start = html.indexOf('\n' + head);
      if (start >= 0) return html.slice(start, html.indexOf('\n}', start) + 2);
    }
    throw new Error('missing ' + name);
  };
  const calls = [];
  const yt = {
    state: -1, time: 0, muted: false,
    getPlayerState() { return this.state; }, getCurrentTime() { return this.time; }, getDuration() { return 300; },
    isMuted() { return this.muted; }, mute() { this.muted = true; }, unMute() { this.muted = false; },
    playVideo() { this.state = 1; calls.push('playVideo'); }, pauseVideo() { this.state = 2; calls.push('pauseVideo'); },
    seekTo(t) { this.time = t; calls.push('seek:' + Math.round(t)); },
  };
  const native = { pause: async () => calls.push('native:pause'), play: async () => calls.push('native:play'),
    next: async () => calls.push('native:next'), previous: async () => calls.push('native:previous') };
  const ctx = vm.createContext({
    performance: { now: () => 0 }, setTimeout: () => 0, document: { visibilityState: 'visible' },
    ytData: { a: { video_id: 'vidA' } }, loadYT: async () => ({}), findTrackById: () => ({ name: 'Song A' }),
    ytPlayNow: (v, title, id) => calls.push('ytPlayNow:' + v + ':' + id),
    ytAPIPlayer: yt, ytVideoId: 'vidA', ytPlayerEl: {}, _taAudioEl: null, _taBgActive: false, _taManualAudio: false,
    _ytUserWantsPlay: true, _lyrSyncEnabled: false, _lyrSyncTimer: null, syncedLyricsCache: {},
    ytpSetPlayPauseIcon: () => {}, lyrSyncStart: () => {}, sjDlPlugin: () => native,
  });
  vm.runInContext('var _sjCarFollow = null; var _sjCarFollowDriving = false;\n' +
    ['sjCarFollowTime', 'sjCarOnNativeStatus', 'sjCarFollowLoad', 'sjCarFollowAlign', 'sjCarFollowStop', 'sjCarFollowCommand']
      .map(fn).join('\n'), ctx);

  // A paused engine left over from an earlier drive is not followed.
  await ctx.sjCarOnNativeStatus({ state: 'paused', trackId: 'a', positionSeconds: 5 });
  assert.equal(calls.length, 0);

  // The car plays A: the page loads A's video and holds it, muted, to the car.
  await ctx.sjCarOnNativeStatus({ state: 'playing', trackId: 'a', positionSeconds: 40, title: 'Song A' });
  assert.deepEqual(calls.splice(0), ['ytPlayNow:vidA:a']);
  assert.equal(ctx._ytUserWantsPlay, false);
  await ctx.sjCarOnNativeStatus({ state: 'playing', trackId: 'a', positionSeconds: 41 });
  assert.equal(yt.muted, true);
  assert.deepEqual(calls.splice(0), ['playVideo', 'seek:41']);

  // Small drift is left alone; a pause in the car pauses the video.
  yt.time = 41.5;
  await ctx.sjCarOnNativeStatus({ state: 'paused', trackId: 'a', positionSeconds: 42 });
  assert.deepEqual(calls.splice(0), ['pauseVideo']);

  // The phone's buttons drive the car.
  assert.equal(ctx.sjCarFollowCommand('toggle'), true);
  assert.equal(ctx.sjCarFollowCommand('next'), true);
  assert.deepEqual(calls.filter(c => c.startsWith('native:')), ['native:play', 'native:next']);
  calls.length = 0;

  // The passenger picks something else: following ends, sound returns, the car pauses.
  ctx.sjCarFollowStop(true);
  assert.equal(ctx._sjCarFollow, null);
  assert.equal(yt.muted, false);
  assert.deepEqual(calls, ['native:pause']);
  assert.equal(ctx.sjCarFollowCommand('next'), false);

  // Nothing happens while the app is in the background.
  calls.length = 0;
  ctx.document.visibilityState = 'hidden';
  await ctx.sjCarOnNativeStatus({ state: 'playing', trackId: 'a', positionSeconds: 1 });
  assert.equal(calls.length, 0);
});
