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
        let kind: String        // "rate" | "heart"
        let trackId: String
        let value: Int          // rate: 1 or 0. heart: unused.
        let positionMs: Int
        let at: Double          // epoch seconds, so the web layer can order them
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

    func add(kind: String, trackId: String, value: Int, positionMs: Int) {
        queue.sync(flags: .barrier) {
            items.append(Item(id: UUID().uuidString,
                              kind: kind,
                              trackId: trackId,
                              value: value,
                              positionMs: positionMs,
                              at: Date().timeIntervalSince1970))
            // A drive with a stuck web view should not grow without bound.
            if items.count > 500 { items.removeFirst(items.count - 500) }
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
