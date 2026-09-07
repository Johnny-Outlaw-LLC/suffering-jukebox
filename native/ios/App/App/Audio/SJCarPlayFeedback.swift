import Foundation

/// The small piece of shared state between the car and the web layer.
///
/// The CarPlay scene and the Capacitor plugin never see each other - one is
/// driven by the car, the other by the web view, and either can be absent. This
/// holds what they both need: which tracks the listener has already rated (so
/// the thumb draws filled), the all-time heart count on each track (so the
/// heart button can show one), and a nudge to say a tap happened.
final class SJCarPlayFeedback {

    static let shared = SJCarPlayFeedback()

    private let lock = NSLock()
    private var rated: Set<String> = []
    private var hearts: [String: Int] = [:]

    /// Set by the plugin. Fired by the car when something is tapped, so the web
    /// layer can drain the outbox promptly instead of waiting for the next
    /// launch - when it happens to be awake and online.
    var onChange: (() -> Void)?

    private init() {}

    var ratedTrackIds: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return rated
    }

    func setRated(_ ids: [String]) {
        lock.lock(); defer { lock.unlock() }
        rated = Set(ids)
    }

    func heartCount(for trackId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return hearts[trackId] ?? 0
    }

    func setHeartCounts(_ counts: [String: Int]) {
        lock.lock(); defer { lock.unlock() }
        hearts = counts
    }
}
