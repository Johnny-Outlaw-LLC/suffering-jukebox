import Foundation

/// Playlist membership for the car.
///
/// The download index knows songs, not running orders, so CarPlay had no way to
/// offer a playlist at all. The web layer pushes what it already has whenever
/// playlists load or a download finishes; this keeps a copy on disk so the
/// Playlists tab is populated on a cold start in a car park with no signal.
///
/// Only ids are stored. Which of those songs is actually playable is decided at
/// render time against SJDownloadStore, so a playlist can never promise a track
/// the car cannot play, and removing a download does not need a write here.
final class SJPlaylistStore {

    struct Playlist: Codable {
        let id: String
        var name: String
        var trackIds: [String]
    }

    static let shared = SJPlaylistStore()

    private let queue = DispatchQueue(label: "sj.playlists", attributes: .concurrent)
    private var playlists: [Playlist] = []

    private lazy var url: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("SufferingJukebox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("playlists.json")
    }()

    private init() {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([Playlist].self, from: data) else { return }
        playlists = decoded
    }

    func replaceAll(_ next: [Playlist]) {
        queue.sync(flags: .barrier) {
            playlists = next
            if let data = try? JSONEncoder().encode(next) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    func all() -> [Playlist] { queue.sync { playlists } }

    /// Playlists with at least one song on the device, each narrowed to the
    /// songs that will actually play, in the running order the listener saved.
    func playable() -> [(playlist: Playlist, entries: [SJDownloadStore.Entry])] {
        all().compactMap { playlist in
            let entries = playlist.trackIds.compactMap { SJDownloadStore.shared.entry(for: $0) }
            return entries.isEmpty ? nil : (playlist, entries)
        }
    }
}
