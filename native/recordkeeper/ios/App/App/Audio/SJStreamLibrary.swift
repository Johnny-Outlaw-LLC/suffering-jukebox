import Foundation
import Security
import UIKit

/// Songs the car can stream without a download.
///
/// Two kinds, from one server list (/api/sj-carplay-library):
///   - the signed-in listener's own uploads ("mine"), so uploading an MP3 for
///     background play is enough to hear it in the car;
///   - every artist-licensed song ("artist"), for everybody, signed in or not.
///
/// The car cannot sign in (CarPlay offers no way to type a password or show a
/// web sign-in sheet) and the web view is asleep during a drive, so the
/// phone holds a car key (Keychain) issued by /api/sj-carplay-key while the
/// listener was signed in, and trades it for a fresh signed URL at the moment
/// a song starts (/api/sj-carplay-stream). A presigned URL handed over earlier
/// would have expired by the time anyone got in the car.
///
/// A downloaded file always wins over streaming (SJAudioEngine.playableURL),
/// so offline behaviour is unchanged.
final class SJStreamLibrary {

    struct Entry: Codable {
        let trackId: String
        var title: String
        var artist: String
        var album: String?
        var durationSeconds: Double
        var artworkURL: String?
        var source: String          // "mine" | "artist"
    }

    static let shared = SJStreamLibrary()

    /// Fired on the main queue after the list changes, so the car can repaint.
    var onChange: (() -> Void)?

    /// Used until the web layer has told us which site it is, so a phone that
    /// has never signed in still finds the artist-licensed songs.
    /// The apex, not www: www answers with a redirect, and a redirect can drop
    /// the Authorization header that carries the car key.
    static let defaultBaseURL = "https://recordkeeper.stream"

    private let queue = DispatchQueue(label: "sj.stream", attributes: .concurrent)
    private var entries: [String: Entry] = [:]
    private var resolved: [String: (url: URL, expires: Date)] = [:]
    private var refreshing = false

    private lazy var dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("SufferingJukebox/Stream", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        var mutable = d
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
        return d
    }()

    private var indexURL: URL { dir.appendingPathComponent("library.json") }

    private init() {
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([Entry].self, from: data) {
            entries = Dictionary(decoded.map { ($0.trackId, $0) }, uniquingKeysWith: { a, _ in a })
        }
    }

    // MARK: - Access (who the phone is)

    private static let baseDefaultsKey = "sj.carplay.baseURL"
    private static let emailDefaultsKey = "rk.carplay.keyEmail"
    private static let nameDefaultsKey = "sj.carplay.accountName"
    private static let signedInDefaultsKey = "sj.carplay.signedIn"
    private static let keychainService = "rk.carplay.key"

    var baseURL: String {
        UserDefaults.standard.string(forKey: Self.baseDefaultsKey) ?? Self.defaultBaseURL
    }

    var keyEmail: String? { UserDefaults.standard.string(forKey: Self.emailDefaultsKey) }

    var hasKey: Bool { Self.readKey() != nil }

    /// Who the car is signed in as, for the corner of every CarPlay tab.
    var accountName: String? {
        UserDefaults.standard.string(forKey: Self.nameDefaultsKey) ?? keyEmail
    }

    /// What the server said about the key on the last refresh that reached it,
    /// or nil before one ever has. Persisted, because the car is often started
    /// with no signal and should not claim the listener is signed out.
    var keyAccepted: Bool? {
        UserDefaults.standard.object(forKey: Self.signedInDefaultsKey) as? Bool
    }

    /// Signed in as far as the car can tell: holding a key the server has not
    /// rejected.
    var isSignedIn: Bool { hasKey && keyAccepted != false }

    func setAccess(baseURL: String?, key: String?, email: String?, name: String? = nil) {
        if let baseURL, baseURL.hasPrefix("https://") {
            UserDefaults.standard.set(baseURL, forKey: Self.baseDefaultsKey)
        }
        if let key, !key.isEmpty {
            Self.writeKey(key)
            UserDefaults.standard.set(email, forKey: Self.emailDefaultsKey)
            UserDefaults.standard.set(name, forKey: Self.nameDefaultsKey)
            // A fresh key has not been rejected; the refresh below confirms it.
            UserDefaults.standard.removeObject(forKey: Self.signedInDefaultsKey)
        }
        queue.sync(flags: .barrier) { resolved.removeAll() }
        refresh()
    }

    /// Sign-out: revoke the key server side, forget it, and drop the listener's
    /// own songs from the car. Artist-licensed songs stay.
    func clearAccess() {
        if let key = Self.readKey(), let url = URL(string: baseURL + "/api/sj-carplay-key") {
            var req = URLRequest(url: url)
            req.httpMethod = "DELETE"
            req.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
            URLSession.shared.dataTask(with: req).resume()
        }
        Self.deleteKey()
        UserDefaults.standard.removeObject(forKey: Self.emailDefaultsKey)
        UserDefaults.standard.removeObject(forKey: Self.nameDefaultsKey)
        UserDefaults.standard.removeObject(forKey: Self.signedInDefaultsKey)
        queue.sync(flags: .barrier) {
            entries = entries.filter { $0.value.source != "mine" }
            resolved.removeAll()
            persistLocked()
        }
        DispatchQueue.main.async { self.onChange?() }
        refresh()
    }

    // MARK: - Queries

    func all() -> [Entry] { queue.sync { Array(entries.values) } }

    func entry(for trackId: String) -> Entry? { queue.sync { entries[trackId] } }

    func contains(_ trackId: String) -> Bool { entry(for: trackId) != nil }

    func artworkFileURL(for trackId: String) -> URL? {
        let url = dir.appendingPathComponent("\(trackId).art")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - Refresh

    /// Re-read the list from the server. Called on launch, on every return to
    /// the foreground, when CarPlay connects, and after an upload. A failure
    /// (no signal in a car park) keeps the last list on disk.
    func refresh(completion: ((Bool) -> Void)? = nil) {
        let already: Bool = queue.sync(flags: .barrier) {
            if refreshing { return true }
            refreshing = true
            return false
        }
        if already { completion?(false); return }
        guard let url = URL(string: baseURL + "/api/sj-carplay-library") else {
            queue.sync(flags: .barrier) { refreshing = false }
            completion?(false)
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        let sentKey = Self.readKey()
        if let sentKey { req.setValue("Bearer " + sentKey, forHTTPHeaderField: "Authorization") }
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            guard let self else { return }
            defer { self.queue.sync(flags: .barrier) { self.refreshing = false } }
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["ok"] as? Bool == true,
                  let rows = json["tracks"] as? [[String: Any]] else {
                completion?(false)
                return
            }
            let next: [Entry] = rows.compactMap { r in
                guard let id = r["id"] as? String, let title = r["title"] as? String else { return nil }
                return Entry(trackId: id,
                             title: title,
                             artist: r["artist"] as? String ?? "",
                             album: r["album"] as? String,
                             durationSeconds: (r["durationSeconds"] as? Double)
                                ?? Double(r["durationSeconds"] as? Int ?? 0),
                             artworkURL: r["artworkUrl"] as? String,
                             source: r["source"] as? String ?? "artist")
            }
            // Only judge the key that was actually sent: a sign-in or sign-out
            // that landed mid-request owns the state now.
            if sentKey != nil, sentKey == Self.readKey() {
                let signedIn = json["signedIn"] as? Bool ?? false
                UserDefaults.standard.set(signedIn, forKey: Self.signedInDefaultsKey)
                if signedIn, let account = json["account"] as? [String: Any],
                   let name = account["name"] as? String, !name.isEmpty {
                    UserDefaults.standard.set(name, forKey: Self.nameDefaultsKey)
                }
            }
            self.queue.sync(flags: .barrier) {
                self.entries = Dictionary(next.map { ($0.trackId, $0) }, uniquingKeysWith: { a, _ in a })
                self.persistLocked()
            }
            DispatchQueue.main.async { self.onChange?() }
            self.fetchMissingArtwork(next)
            completion?(true)
        }.resume()
    }

    private func persistLocked() {
        if let data = try? JSONEncoder().encode(Array(entries.values)) {
            try? data.write(to: indexURL, options: .atomic)
        }
    }

    /// Covers are cached to disk once, so a list drawn in a car with no signal
    /// still has pictures. One request at a time: a 600 song locker should not
    /// open 600 sockets on cellular.
    private func fetchMissingArtwork(_ list: [Entry]) {
        let missing = list.filter { artworkFileURL(for: $0.trackId) == nil && $0.artworkURL != nil }
        // Songs off one album share a cover; fetch each address once.
        var byURL: [String: [String]] = [:]
        for e in missing { byURL[e.artworkURL!, default: []].append(e.trackId) }
        var pending = Array(byURL)
        func nextOne() {
            guard !pending.isEmpty else {
                DispatchQueue.main.async { self.onChange?() }
                return
            }
            let (address, ids) = pending.removeFirst()
            guard let url = URL(string: address) else { nextOne(); return }
            URLSession.shared.dataTask(with: url) { data, _, _ in
                if let data, UIImage(data: data) != nil {
                    for id in ids {
                        try? data.write(to: self.dir.appendingPathComponent("\(id).art"), options: .atomic)
                    }
                }
                nextOne()
            }.resume()
        }
        nextOne()
    }

    // MARK: - Resolving a URL

    /// A signed URL for one song, fetched at the moment it is needed. Cached
    /// until half an hour before it expires, so skipping back and forth on a
    /// drive does not ask again for every song.
    func resolve(trackId: String, completion: @escaping (URL?) -> Void) {
        if let hit = queue.sync(execute: { resolved[trackId] }), hit.expires > Date() {
            completion(hit.url)
            return
        }
        var comps = URLComponents(string: baseURL + "/api/sj-carplay-stream")
        comps?.queryItems = [URLQueryItem(name: "track_id", value: trackId)]
        guard let url = comps?.url else { completion(nil); return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        if let key = Self.readKey() { req.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            guard let self,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let address = json["url"] as? String,
                  let signed = URL(string: address) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                NSLog("[SJAudio] Stream resolution failed track=%@ status=%ld error=%@", trackId, status, error?.localizedDescription ?? "invalid response")
                completion(nil)
                return
            }
            NSLog("[SJAudio] Stream resolved track=%@", trackId)
            let seconds = (json["expiresIn"] as? Double) ?? Double(json["expiresIn"] as? Int ?? 3600)
            let expires = Date().addingTimeInterval(max(60, seconds - 30 * 60))
            self.queue.sync(flags: .barrier) { self.resolved[trackId] = (signed, expires) }
            completion(signed)
        }.resume()
    }

    // MARK: - Keychain

    private static func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: "carKey"]
    }

    private static func readKey() -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func writeKey(_ key: String) {
        deleteKey()
        var q = baseQuery()
        q[kSecValueData as String] = Data(key.utf8)
        // Readable after the first unlock since boot: CarPlay commonly starts
        // the app while the phone is locked in a pocket.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    private static func deleteKey() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

/// One row the car can offer: a download, a stream, or both. Downloads win on
/// every field, because their metadata was captured with the file.
struct SJCarEntry {
    let trackId: String
    let title: String
    let artist: String
    let album: String?
    let durationSeconds: Double
    let downloaded: Bool
}

enum SJCarLibrary {

    static func all() -> [SJCarEntry] {
        allIncludingExcluded().filter { !SJCarPlayExclusions.shared.contains($0.trackId) }
    }

    static func allIncludingExcluded() -> [SJCarEntry] {
        var out: [String: SJCarEntry] = [:]
        for s in SJStreamLibrary.shared.all() {
            out[s.trackId] = SJCarEntry(trackId: s.trackId, title: s.title, artist: s.artist,
                                        album: s.album, durationSeconds: s.durationSeconds, downloaded: false)
        }
        for d in SJDownloadStore.shared.all() { out[d.trackId] = make(d) }
        return Array(out.values)
    }

    static func entry(for trackId: String) -> SJCarEntry? {
        guard !SJCarPlayExclusions.shared.contains(trackId) else { return nil }
        return entryIncludingExcluded(for: trackId)
    }

    static func entryIncludingExcluded(for trackId: String) -> SJCarEntry? {
        if let d = SJDownloadStore.shared.entry(for: trackId) { return make(d) }
        guard let s = SJStreamLibrary.shared.entry(for: trackId) else { return nil }
        return SJCarEntry(trackId: s.trackId, title: s.title, artist: s.artist,
                          album: s.album, durationSeconds: s.durationSeconds, downloaded: false)
    }

    static func artworkFileURL(for trackId: String) -> URL? {
        if let d = SJDownloadStore.shared.entry(for: trackId),
           let url = SJDownloadStore.shared.artworkURL(for: d),
           FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return SJStreamLibrary.shared.artworkFileURL(for: trackId)
    }

    private static func make(_ d: SJDownloadStore.Entry) -> SJCarEntry {
        SJCarEntry(trackId: d.trackId, title: d.title, artist: d.artist,
                   album: d.album, durationSeconds: d.durationSeconds, downloaded: true)
    }
}
