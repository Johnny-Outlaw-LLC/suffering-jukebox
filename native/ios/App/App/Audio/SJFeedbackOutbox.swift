import Foundation

/// Ratings and reactions tapped in the car, held until the web layer can send them.
///
/// A CarPlay tap is the worst case for a straight bridge call: the app is
/// backgrounded, the web view may be suspended, and a car park is exactly where
/// there is no signal. Firing an event at JavaScript and hoping would drop taps
/// silently, which is worse than not offering the button. So every press lands
/// on disk first and is drained when the app is next awake and online.
///
/// Deliberately append-only and tiny. The web layer owns what a rating or a
/// reaction actually means; this only remembers that one happened.
final class SJFeedbackOutbox {

    struct Item: Codable {
        let id: String
        let kind: String        // "rate" | "heart" | "play"
        let trackId: String
        let value: Int          // rate: 1 or 0. heart and play: unused.
        let positionMs: Int
        let at: Double          // epoch seconds, so the web layer can order them
        /// How long a "play" was actually listened to. Optional so an outbox
        /// written before plays were recorded still decodes.
        var ms: Int?
    }

    static let shared = SJFeedbackOutbox()

    private let queue = DispatchQueue(label: "sj.feedback", attributes: .concurrent)
    private var items: [Item] = []

    private lazy var url: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("SufferingJukebox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("feedback-outbox.json")
    }()

    private init() {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([Item].self, from: data) else { return }
        items = decoded
    }

    private func persistLocked() {
        if let data = try? JSONEncoder().encode(items) {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Returns the new item's id, so a play can have its duration filled in
    /// when the song is actually left.
    @discardableResult
    func add(kind: String, trackId: String, value: Int, positionMs: Int,
             at when: Double = Date().timeIntervalSince1970, ms: Int? = nil) -> String {
        let id = UUID().uuidString
        queue.sync(flags: .barrier) {
            items.append(Item(id: id,
                              kind: kind,
                              trackId: trackId,
                              value: value,
                              positionMs: positionMs,
                              at: when,
                              ms: ms))
            // A drive with a stuck web view should not grow without bound.
            if items.count > 500 { items.removeFirst(items.count - 500) }
            persistLocked()
        }
        return id
    }

    /// How long a play that is already in the outbox ended up running for.
    ///
    /// A play is written the moment it crosses the listen threshold, not when
    /// it ends, so an app the car kills mid-song still counts it. The duration
    /// is the one thing that cannot be known at that point, so it is filled in
    /// afterwards - and if the app dies first the row simply carries no
    /// duration, which every reader already handles.
    func setPlayedMs(id: String, ms: Int) {
        queue.sync(flags: .barrier) {
            guard let i = items.firstIndex(where: { $0.id == id }) else { return }
            items[i].ms = max(0, ms)
            persistLocked()
        }
    }

    func pending() -> [Item] { queue.sync { items } }

    /// Drop what the web layer confirms it has sent. Ids rather than a clear, so
    /// a tap made while a drain was in flight is not thrown away with it.
    func acknowledge(ids: [String]) {
        let done = Set(ids)
        queue.sync(flags: .barrier) {
            items.removeAll { done.contains($0.id) }
            persistLocked()
        }
    }

    /// Ratings tapped in the car that the web layer has not yet absorbed, so the
    /// button can show the state the listener actually left it in.
    func pendingRatings() -> [String: Int] {
        var out: [String: Int] = [:]
        for item in pending() where item.kind == "rate" { out[item.trackId] = item.value }
        return out
    }
}
