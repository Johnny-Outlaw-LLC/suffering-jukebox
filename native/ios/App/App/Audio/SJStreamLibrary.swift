import Foundation

/// Songs the car can stream without a download.
///
/// CarPlay used to be the download locker and nothing else, so a car with
/// perfectly good signal said "Nothing downloaded yet" until songs had been
/// queued on a desktop and accepted on the phone. This holds the list from
/// /api/sj-carplay-library - approved artist uploads plus the listener's own -
/// each with a signed URL good for a week.
///
/// The web layer pushes it whenever the app is open, because only the web view
/// holds a session. The artist half needs no session, so native refreshes that
/// part itself when it goes stale; personal tracks simply drop out once their
/// URLs expire, until the app is next opened on the phone.
final class SJStreamLibrary {

    struct Entry: Codable {
        let trackId: String
        var title: String
        var artist: String
        var album: String?
        var artworkUrl: String?
        var durationSeconds: Double
        var url: String
        /// "artist" (public, refreshable without a session) or "personal".
        var source: String
        /// Unix seconds after which `url` no longer works.
        var expiresAt: Double
    }

    private struct Snapshot: Codable {
        var entries: [Entry]
        var artistFetchedAt: Double
    }

    static let shared = SJStreamLibrary()

    static let origin = URL(string: "https://www.sufferingjukebox.stream")!

    /// A URL this close to expiry is not handed to the player: a song started
    /// on it could die partway through.
    private static let expiryMargin: TimeInterval = 15 * 60
    private static let artistRefreshInterval: TimeInterval = 24 * 60 * 60

    private let queue = DispatchQueue(label: "sj.streamlibrary", attributes: .concurrent)
    private var snapshot = Snapshot(entries: [], artistFetchedAt: 0)
    private var refreshing = false

    private lazy var url: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("SufferingJukebox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("stream-library.json")
    }()

    private init() {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
        snapshot = decoded
    }

    private func persist(_ next: Snapshot) {
        if let data = try? JSONEncoder().encode(next) {
            try? data.write(to: url, options: .atomic)
        }
    }

    // MARK: - Queries

    /// Entries whose URL will still work for a whole song.
    func playable() -> [Entry] {
        let cutoff = Date().timeIntervalSince1970 + Self.expiryMargin
        return queue.sync { snapshot.entries.filter { $0.expiresAt > cutoff } }
    }

    func entry(for trackId: String) -> Entry? {
        let cutoff = Date().timeIntervalSince1970 + Self.expiryMargin
        return queue.sync { snapshot.entries.first { $0.trackId == trackId && $0.expiresAt > cutoff } }
    }

    /// Personal songs that were on the list but whose URLs have run out -
    /// what the car should nudge the listener to fix by opening the app.
    func hasExpiredPersonal() -> Bool {
        let cutoff = Date().timeIntervalSince1970 + Self.expiryMargin
        return queue.sync { snapshot.entries.contains { $0.source == "personal" && $0.expiresAt <= cutoff } }
    }

    // MARK: - Mutation

    /// Replace the artist half, and the personal half too when `personal` is
    /// given. Nil keeps what is there: a sessionless refresh knows nothing
    /// about the listener's own songs and must not wipe them.
    func replace(artist: [Entry], personal: [Entry]?) {
        queue.sync(flags: .barrier) {
            let kept = personal ?? snapshot.entries.filter { $0.source == "personal" }
            snapshot = Snapshot(entries: artist + kept, artistFetchedAt: Date().timeIntervalSince1970)
            persist(snapshot)
        }
    }

    /// Decode the endpoint's reply into entries, split by half.
    static func parse(tracks: [[String: Any]], expiresAt: Double) -> (artist: [Entry], personal: [Entry]) {
        var artist: [Entry] = []
        var personal: [Entry] = []
        for t in tracks {
            guard let id = t["trackId"] as? String, !id.isEmpty,
                  let url = t["url"] as? String, !url.isEmpty else { continue }
            let album = (t["album"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let entry = Entry(
                trackId: id,
                title: (t["title"] as? String) ?? "Untitled",
                artist: (t["artist"] as? String) ?? "",
                album: album,
                artworkUrl: t["artworkUrl"] as? String,
                durationSeconds: (t["durationSeconds"] as? NSNumber)?.doubleValue ?? 0,
                url: url,
                source: (t["source"] as? String) == "personal" ? "personal" : "artist",
                expiresAt: expiresAt
            )
            if entry.source == "personal" { personal.append(entry) } else { artist.append(entry) }
        }
        return (artist, personal)
    }

    /// Fetch the artist half with no session, if it is a day old or any of
    /// its URLs is close to running out. Safe to call on every car connect.
    func refreshArtistsIfStale(completion: @escaping (Bool) -> Void = { _ in }) {
        let now = Date().timeIntervalSince1970
        let stale: Bool = queue.sync {
            let soonest = snapshot.entries.filter { $0.source == "artist" }.map(\.expiresAt).min()
            return now - snapshot.artistFetchedAt > Self.artistRefreshInterval
                || (soonest.map { $0 - now < 2 * 24 * 60 * 60 } ?? false)
        }
        guard stale else { completion(false); return }
        let started: Bool = queue.sync(flags: .barrier) {
            if refreshing { return false }
            refreshing = true
            return true
        }
        guard started else { completion(false); return }

        var request = URLRequest(url: Self.origin.appendingPathComponent("api/sj-carplay-library"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            defer { self.queue.sync(flags: .barrier) { self.refreshing = false } }
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["ok"] as? Bool == true,
                  let tracks = json["tracks"] as? [[String: Any]] else {
                DispatchQueue.main.async { completion(false) }
                return
            }
            let expiresAt = (json["expiresAt"] as? NSNumber)?.doubleValue ?? 0
            let parsed = Self.parse(tracks: tracks, expiresAt: expiresAt)
            self.replace(artist: parsed.artist, personal: nil)
            DispatchQueue.main.async { completion(true) }
        }.resume()
    }
}

/// One song the car can offer: a download, a stream, or both (the download wins).
///
/// CarPlay's lists are built from this rather than from either store directly,
/// so Artists, Playlists and Songs cannot disagree about what is playable.
struct SJCarTrack {
    let trackId: String
    let title: String
    let artist: String
    let album: String?
    let durationSeconds: Double
    /// Set when the file is on the phone; its cover is on disk too.
    let download: SJDownloadStore.Entry?
    /// Signed stream URL. Nil for a download: the engine plays the file.
    let streamURL: URL?
    /// Remote cover for a streamed song.
    let artworkURL: URL?

    var isDownloaded: Bool { download != nil }

    init(download e: SJDownloadStore.Entry) {
        trackId = e.trackId; title = e.title; artist = e.artist; album = e.album
        durationSeconds = e.durationSeconds; download = e
        // The file is what plays and its cover is on disk; no network needed.
        streamURL = nil
        artworkURL = nil
    }

    init?(stream e: SJStreamLibrary.Entry) {
        guard let url = URL(string: e.url) else { return nil }
        trackId = e.trackId; title = e.title; artist = e.artist; album = e.album
        durationSeconds = e.durationSeconds; download = nil
        streamURL = url
        artworkURL = e.artworkUrl.flatMap(URL.init(string:))
    }
}

enum SJCarLibrary {
    /// Everything the car can play right now, downloads first.
    static func all() -> [SJCarTrack] {
        let downloads = SJDownloadStore.shared.all()
        let have = Set(downloads.map(\.trackId))
        let streams = SJStreamLibrary.shared.playable()
            .filter { !have.contains($0.trackId) }
            .compactMap(SJCarTrack.init(stream:))
        return downloads.map(SJCarTrack.init(download:)) + streams
    }

    static func track(for trackId: String) -> SJCarTrack? {
        if let d = SJDownloadStore.shared.entry(for: trackId) { return SJCarTrack(download: d) }
        return SJStreamLibrary.shared.entry(for: trackId).flatMap(SJCarTrack.init(stream:))
    }
}
