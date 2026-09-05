import Foundation

/// Local storage for locker tracks the listener has taken offline.
///
/// Files live in Application Support, not Caches: iOS evicts Caches under disk
/// pressure, and a download that vanishes mid-drive is exactly the failure this
/// feature exists to prevent. They are excluded from iCloud backup instead,
/// since every file can be re-fetched from the locker.
final class SJDownloadStore {

    struct Entry: Codable {
        let trackId: String
        var bytes: Int64
        var fileName: String
        var title: String
        var artist: String
        var album: String?
        var durationSeconds: Double
        var artworkFileName: String?
    }

    static let shared = SJDownloadStore()

    private let queue = DispatchQueue(label: "sj.downloads", attributes: .concurrent)
    private var entries: [String: Entry] = [:]

    private lazy var root: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("SufferingJukebox/Audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var mutable = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
        return dir
    }()

    private var indexURL: URL { root.appendingPathComponent("index.json") }

    private init() { load() }

    // MARK: - Index

    private func load() {
        guard let data = try? Data(contentsOf: indexURL),
              let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) else { return }
        // Drop entries whose file was removed out from under us, so callers
        // never see a "downloaded" track that cannot actually play.
        entries = decoded.filter { FileManager.default.fileExists(atPath: fileURL(for: $0.value).path) }
        if entries.count != decoded.count { persist() }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    // MARK: - Paths

    func fileURL(for entry: Entry) -> URL { root.appendingPathComponent(entry.fileName) }

    func artworkURL(for entry: Entry) -> URL? {
        entry.artworkFileName.map { root.appendingPathComponent($0) }
    }

    /// Where a finished download should land. Extension is preserved so
    /// AVPlayer can pick a demuxer without sniffing.
    func destination(trackId: String, suggestedExtension ext: String) -> URL {
        let safe = ext.isEmpty ? "mp3" : ext.lowercased().filter { $0.isLetter || $0.isNumber }
        return root.appendingPathComponent("\(trackId).\(safe.isEmpty ? "mp3" : safe)")
    }

    // MARK: - Queries

    func entry(for trackId: String) -> Entry? {
        queue.sync { entries[trackId] }
    }

    func isDownloaded(_ trackId: String) -> Bool { entry(for: trackId) != nil }

    func all() -> [Entry] {
        queue.sync { Array(entries.values) }.sorted {
            ($0.artist, $0.album ?? "", $0.title) < ($1.artist, $1.album ?? "", $1.title)
        }
    }

    func bytesUsed() -> Int64 {
        queue.sync { entries.values.reduce(0) { $0 + $1.bytes } }
    }

    /// A local URL to play, or nil when the track is not downloaded.
    func localURL(for trackId: String) -> URL? {
        guard let e = entry(for: trackId) else { return nil }
        let url = fileURL(for: e)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - Mutation

    func add(_ entry: Entry) {
        queue.sync(flags: .barrier) {
            entries[entry.trackId] = entry
            persist()
        }
    }

    func remove(trackId: String) {
        queue.sync(flags: .barrier) {
            guard let e = entries.removeValue(forKey: trackId) else { return }
            try? FileManager.default.removeItem(at: fileURL(for: e))
            if let art = artworkURL(for: e) { try? FileManager.default.removeItem(at: art) }
            persist()
        }
    }

    func storeArtwork(_ data: Data, trackId: String) -> String? {
        let name = "\(trackId).art"
        let url = root.appendingPathComponent(name)
        guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return name
    }

    /// Attach a cover to a track that is already downloaded.
    ///
    /// Downloads taken before the metadata pipeline carried album art have no
    /// cover on disk, and the car has no network to go and find one. Re-fetching
    /// the audio to fix a thumbnail would be absurd, so the image is repaired in
    /// place instead.
    @discardableResult
    func attachArtwork(_ data: Data, trackId: String) -> Bool {
        guard let name = storeArtwork(data, trackId: trackId) else { return false }
        return queue.sync(flags: .barrier) {
            guard var entry = entries[trackId] else { return false }
            entry.artworkFileName = name
            entries[trackId] = entry
            persist()
            return true
        }
    }

    /// Downloaded tracks with no cover on disk - what a backfill has to repair.
    func missingArtwork() -> [Entry] {
        all().filter { entry in
            guard let art = artworkURL(for: entry) else { return true }
            return !FileManager.default.fileExists(atPath: art.path)
        }
    }
}
