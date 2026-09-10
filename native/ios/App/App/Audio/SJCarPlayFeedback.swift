import Foundation

/// The small piece of shared state between the car and the web layer.
///
/// The CarPlay scene and the Capacitor plugin never see each other - one is
/// driven by the car, the other by the web view, and either can be absent. This
/// holds what they both need: which tracks the listener has already rated (so
/// the thumb draws filled), the all-time heart count on each track (so the
/// heart button can show one), and a nudge to say a tap happened.
///
/// **It is kept on disk, like downloads, playlists and play counts.** Getting
/// into the car launches this app with the CarPlay scene ALONE - the web view
/// never loads, so nothing ever calls setRated/setHeartCounts on that run. Held
/// only in memory, every song came up unrated in the car however many thumbs it
/// had been given on the site.
final class SJCarPlayFeedback {

    static let shared = SJCarPlayFeedback()

    private let lock = NSLock()
    private var rated: Set<String> = []
    private var hearts: [String: Int] = [:]

    private let ratedKey  = "sj.carplay.ratedTrackIds"
    private let heartsKey = "sj.carplay.heartCounts"

    /// Set by the plugin. Fired by the car when something is tapped, so the web
    /// layer can drain the outbox promptly instead of waiting for the next
    /// launch - when it happens to be awake and online.
    var onChange: (() -> Void)?

    private init() {
        rated = Set(UserDefaults.standard.stringArray(forKey: ratedKey) ?? [])
        hearts = UserDefaults.standard.dictionary(forKey: heartsKey) as? [String: Int] ?? [:]
    }

    var ratedTrackIds: Set<String> {
        lock.lock(); defer { lock.unlock() }
        return rated
    }

    func setRated(_ ids: [String]) {
        lock.lock(); defer { lock.unlock() }
        rated = Set(ids)
        UserDefaults.standard.set(Array(rated), forKey: ratedKey)
    }

    func heartCount(for trackId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return hearts[trackId] ?? 0
    }

    func setHeartCounts(_ counts: [String: Int]) {
        lock.lock(); defer { lock.unlock() }
        hearts = counts
        UserDefaults.standard.set(counts, forKey: heartsKey)
    }
}

/// The listener's Shuffle preference and the weight of every song on the phone.
///
/// The website weighs the next song by how often and how recently this account
/// played it, and whether it has a thumbs up. The car can compute none of that:
/// it has no session, no catalogue and, on the drive itself, no network. So the
/// web layer pushes the finished numbers, exactly as it pushes ratings and
/// heart counts, and the car applies them.
///
/// On disk for the same reason as the rest of this file: getting into the car
/// launches the CarPlay scene ALONE and the web view never runs, so a profile
/// held only in memory would be empty on every drive - which is indistinguish-
/// able from having no preference at all.
final class SJShuffleProfile {

    static let shared = SJShuffleProfile()

    private let lock = NSLock()
    private var preference: String
    private var weights: [String: Double]

    private let prefKey    = "sj.carplay.shufflePreference"
    private let weightsKey = "sj.carplay.shuffleWeights"

    private init() {
        preference = UserDefaults.standard.string(forKey: prefKey) ?? "none"
        weights = (UserDefaults.standard.dictionary(forKey: weightsKey) as? [String: Double]) ?? [:]
    }

    /// True when the listener actually chose a weighted mode AND we hold
    /// numbers to apply. Either half missing means an even shuffle, which is
    /// the honest answer rather than a half-applied preference.
    var isWeighted: Bool {
        lock.lock(); defer { lock.unlock() }
        return preference != "none" && !weights.isEmpty
    }

    var preferenceName: String {
        lock.lock(); defer { lock.unlock() }
        return preference
    }

    /// A song we hold no weight for sits at 1.0 - the same as an unweighted
    /// draw - so a download the web layer has not caught up with yet is never
    /// silently excluded from the shuffle.
    func weight(for trackId: String) -> Double {
        lock.lock(); defer { lock.unlock() }
        return max(0.001, weights[trackId] ?? 1.0)
    }

    func set(preference newPreference: String, weights newWeights: [String: Double]) {
        lock.lock(); defer { lock.unlock() }
        preference = newPreference
        weights = newWeights
        UserDefaults.standard.set(preference, forKey: prefKey)
        UserDefaults.standard.set(weights, forKey: weightsKey)
    }
}

