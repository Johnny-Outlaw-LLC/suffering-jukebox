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

test('native partial playlists include one available song and preserve running order', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('../ios/App/App/Audio/SJPlaylistStore.swift', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('    func playable()'), source.lastIndexOf('}'));
  const script = `
import Foundation
class SJDownloadStore {
  struct Entry { let trackId: String }
  static let shared = SJDownloadStore()
  func entry(for id: String) -> Entry? { ["a", "b"].contains(id) ? Entry(trackId: id) : nil }
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
class SJDownloadStore { struct Entry { let trackId: String } }
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
  var played: [SJDownloadStore.Entry] = []
  var first: String?
  func songCount(_ n: Int) -> String { String(n) }
  func play(startingAt entry: SJDownloadStore.Entry, in entries: [SJDownloadStore.Entry]) {
    first = entry.trackId
    played = entries
  }
${method}
}
let subject = Subject()
let entries = (0..<1000).map { SJDownloadStore.Entry(trackId: String($0)) }
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
