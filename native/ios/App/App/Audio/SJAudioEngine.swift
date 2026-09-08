import AVFoundation
import Foundation
import MediaPlayer

struct SJTrack: Equatable {
    let id: String
    let title: String
    let artist: String
    let album: String?
    let artworkURL: URL?
    /// Signed remote URL. Nil when the track is only available offline.
    let url: URL?
    let durationSeconds: Double

    static func == (a: SJTrack, b: SJTrack) -> Bool { a.id == b.id }
}

enum SJPlaybackState: String {
    case idle, buffering, playing, paused, ended
}

enum SJRepeatMode: String {
    case off, all, one

    var next: SJRepeatMode {
        switch self {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }
}

struct SJStatus {
    var state: SJPlaybackState = .idle
    var index: Int = -1
    var trackId: String?
    var positionSeconds: Double = 0
    var durationSeconds: Double = 0
}

protocol SJAudioEngineDelegate: AnyObject {
    func audioEngine(_ engine: SJAudioEngine, didChange status: SJStatus)
    func audioEngine(_ engine: SJAudioEngine, didReceiveRemoteCommand command: String, trackId: String?)
}

/// Owns everything the OS media pipeline touches: the audio session, the
/// player, the Now Playing entry and the remote command centre. CarPlay and
/// the lock screen both drive this object; the web UI is just another caller.
final class SJAudioEngine: NSObject {

    static let shared = SJAudioEngine()

    weak var delegate: SJAudioEngineDelegate?
    /// Set by the CarPlay scene so its now-playing list can follow along.
    var onQueueChanged: (() -> Void)?
    /// Fired when the song itself changes, so the car's rating and reaction
    /// buttons can be redrawn for whatever is playing now. Deliberately not the
    /// twice-a-second tick, which would rebuild them for no reason.
    var onTrackChanged: ((String?) -> Void)?
    /// Fired whenever something the Now Playing buttons draw from changes
    /// without the queue or the track itself changing: shuffle, repeat, or a
    /// fresh rating/heart-count push from the web layer.
    var onModeChanged: (() -> Void)?
    private var lastPublishedTrackId: String??

    private let player = AVPlayer()
    private(set) var queue: [SJTrack] = []
    private(set) var index: Int = -1
    private var timeObserver: Any?
    private var itemEndObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var artworkCache: [String: MPMediaItemArtwork] = [:]

    /// A shuffled permutation of the queue's indices, walked instead of `index
    /// + 1` while shuffle is on. Rebuilt whenever the queue or the setting
    /// changes; the currently playing track is always kept first so turning
    /// shuffle on mid-song does not jump anywhere.
    private var playOrder: [Int] = []

    private(set) var shuffleEnabled: Bool {
        didSet {
            UserDefaults.standard.set(shuffleEnabled, forKey: Self.shuffleDefaultsKey)
            rebuildPlayOrder()
        }
    }
    private(set) var repeatMode: SJRepeatMode {
        didSet { UserDefaults.standard.set(repeatMode.rawValue, forKey: Self.repeatDefaultsKey) }
    }
    private static let shuffleDefaultsKey = "sj.carplay.shuffle"
    private static let repeatDefaultsKey = "sj.carplay.repeat"

    private override init() {
        shuffleEnabled = UserDefaults.standard.bool(forKey: Self.shuffleDefaultsKey)
        repeatMode = SJRepeatMode(rawValue: UserDefaults.standard.string(forKey: Self.repeatDefaultsKey) ?? "") ?? .off
        super.init()
        configureSession()
        configureRemoteCommands()
        observePlayer()
    }

    func setShuffle(_ on: Bool) {
        guard shuffleEnabled != on else { return }
        shuffleEnabled = on
        onModeChanged?()
    }

    func cycleRepeatMode() {
        repeatMode = repeatMode.next
        onModeChanged?()
    }

    private func rebuildPlayOrder() {
        guard shuffleEnabled, !queue.isEmpty else { playOrder = []; return }
        var order = Array(0..<queue.count)
        order.shuffle()
        if index >= 0, let pos = order.firstIndex(of: index) {
            order.remove(at: pos)
            order.insert(index, at: 0)
        }
        playOrder = order
    }

    private func nextIndex() -> Int? {
        guard !queue.isEmpty else { return nil }
        if shuffleEnabled {
            guard let pos = playOrder.firstIndex(of: index) else { return playOrder.first }
            if pos + 1 < playOrder.count { return playOrder[pos + 1] }
            guard repeatMode == .all else { return nil }
            rebuildPlayOrder()
            return playOrder.first
        }
        if index + 1 < queue.count { return index + 1 }
        return repeatMode == .all ? 0 : nil
    }

    private func previousIndex() -> Int? {
        guard !queue.isEmpty else { return nil }
        if shuffleEnabled {
            guard let pos = playOrder.firstIndex(of: index), pos > 0 else {
                return repeatMode == .all ? playOrder.last : nil
            }
            return playOrder[pos - 1]
        }
        if index > 0 { return index - 1 }
        return repeatMode == .all ? queue.count - 1 : nil
    }

    deinit {
        if let t = timeObserver { player.removeTimeObserver(t) }
        if let o = itemEndObserver { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: - Session

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        // .playback is what keeps sound going with the screen off and puts the
        // app in CarPlay's audio app list. Without it the whole feature is moot.
        try? session.setCategory(.playback, mode: .default, policy: .longFormAudio)
        try? session.setActive(true)

        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: session)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification, object: session)
    }

    @objc private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            player.pause()
            publish()
        case .ended:
            let opts = (info[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init)
            if opts?.contains(.shouldResume) == true {
                try? AVAudioSession.sharedInstance().setActive(true)
                player.play()
            }
            publish()
        @unknown default: break
        }
    }

    @objc private func handleRouteChange(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        // Unplugging headphones or leaving the car should pause, not blast
        // through the phone speaker.
        if reason == .oldDeviceUnavailable {
            player.pause()
            publish()
        }
    }

    // MARK: - Player observation

    private func observePlayer() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
            self?.publish(updateNowPlayingTime: true)
        }
        itemEndObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main
        ) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem,
                  item === self.player.currentItem else { return }
            self.advance()
        }
    }

    // MARK: - Queue

    /// Replaces the queue. If the caller is re-handing the track that is
    /// already playing - e.g. the web layer refreshing an expiring signed URL
    /// mid-song - playback continues untouched and only the index moves.
    ///
    /// That shortcut used to trigger whenever the playing track merely
    /// *appeared* anywhere in the new list, which is nearly always true in
    /// CarPlay: Artists, Playlists and Songs all draw from the same download
    /// library. So tapping a different song while something was already
    /// playing silently repointed the index and never called `load` -
    /// nothing happened, and the old track just kept playing. The shortcut
    /// now only applies when the requested start index names the track
    /// that's already playing.
    func setQueue(_ tracks: [SJTrack], startIndex: Int, autoPlay: Bool) {
        let playingId = currentTrack?.id
        let target = tracks.isEmpty ? -1 : max(0, min(startIndex, tracks.count - 1))
        let requestedId = target >= 0 ? tracks[target].id : nil
        queue = tracks

        if let playingId, playingId == requestedId,
           let stillThere = tracks.firstIndex(where: { $0.id == playingId }) {
            index = stillThere
            rebuildPlayOrder()
            updateNowPlaying()
            onQueueChanged?()
            publish()
            return
        }

        index = target
        rebuildPlayOrder()
        onQueueChanged?()
        if target >= 0 {
            load(at: target, autoPlay: autoPlay)
        } else {
            player.replaceCurrentItem(with: nil)
            publish()
        }
    }

    var currentTrack: SJTrack? {
        guard index >= 0 && index < queue.count else { return nil }
        return queue[index]
    }

    /// What plays after this one, honoring shuffle and repeat - so a caller
    /// (the CarPlay Up Next button) can preview it without re-deriving the
    /// queue-walking logic that `nextIndex()` already owns.
    var nextTrack: SJTrack? {
        guard let next = nextIndex(), queue.indices.contains(next) else { return nil }
        return queue[next]
    }

    /// Prefers the downloaded file. Offline is not a mode - if the file is
    /// there it is always used, which also saves cellular data in the car.
    private func playableURL(for track: SJTrack) -> URL? {
        SJDownloadStore.shared.localURL(for: track.id) ?? track.url
    }

    private func load(at newIndex: Int, autoPlay: Bool) {
        guard newIndex >= 0 && newIndex < queue.count else { return }
        index = newIndex
        let track = queue[newIndex]
        guard let url = playableURL(for: track) else {
            // No file and no signed URL: skip rather than stall the queue.
            advance()
            return
        }
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] obs, _ in
            guard let self else { return }
            if obs.status == .failed { self.advance(honorRepeatOne: false) } else { self.publish() }
        }
        if autoPlay { player.play() }
        updateNowPlaying()
        publish()
    }

    /// `honorRepeatOne` is false for a deliberate skip - a manual Next, or a
    /// file that failed to load and is never going to load by trying it again.
    /// Repeat-one only means something for a track that finished on its own.
    private func advance(honorRepeatOne: Bool = true) {
        if honorRepeatOne, repeatMode == .one, index >= 0 {
            load(at: index, autoPlay: true)
            return
        }
        if let next = nextIndex() {
            load(at: next, autoPlay: true)
        } else {
            player.pause()
            publish(state: .ended)
        }
    }

    // MARK: - Transport

    func play(index newIndex: Int? = nil) {
        if let newIndex, newIndex != index {
            load(at: newIndex, autoPlay: true)
            return
        }
        if player.currentItem == nil, index >= 0 {
            load(at: index, autoPlay: true)
            return
        }
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        publish()
    }

    func pause() {
        player.pause()
        publish()
    }

    func togglePlayPause() {
        isPlaying ? pause() : play()
    }

    func next() { advance(honorRepeatOne: false) }

    /// Matches every other music player: restart the track unless you are
    /// already near the top, in which case go back one.
    func previous() {
        if currentPosition > 3, player.currentItem != nil {
            seek(to: 0)
        } else if let prev = previousIndex() {
            load(at: prev, autoPlay: true)
        } else {
            seek(to: 0)
        }
    }

    func seek(to seconds: Double) {
        let time = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        player.seek(to: time) { [weak self] _ in self?.publish(updateNowPlayingTime: true) }
    }

    private var isPlaying: Bool { player.timeControlStatus == .playing }

    private var currentPosition: Double {
        let t = player.currentTime().seconds
        return t.isFinite ? t : 0
    }

    private var currentDuration: Double {
        if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { return d }
        return currentTrack?.durationSeconds ?? 0
    }

    // MARK: - Status

    func status() -> SJStatus {
        var s = SJStatus()
        s.index = index
        s.trackId = currentTrack?.id
        s.positionSeconds = currentPosition
        s.durationSeconds = currentDuration
        switch player.timeControlStatus {
        case .playing: s.state = .playing
        case .waitingToPlayAtSpecifiedRate: s.state = .buffering
        case .paused: s.state = currentTrack == nil ? .idle : .paused
        @unknown default: s.state = .idle
        }
        return s
    }

    private func publish(state: SJPlaybackState? = nil, updateNowPlayingTime: Bool = false) {
        var s = status()
        if let state { s.state = state }
        if updateNowPlayingTime { refreshNowPlayingTime() } else { updateNowPlaying() }
        delegate?.audioEngine(self, didChange: s)
        // Double optional: the outer nil means "never published", so the first
        // track - and a genuine change to no track - both notify exactly once.
        let current = currentTrack?.id
        if lastPublishedTrackId == nil || lastPublishedTrackId! != current {
            lastPublishedTrackId = .some(current)
            onTrackChanged?(current)
        }
    }

    // MARK: - Now Playing

    private func updateNowPlaying() {
        guard let track = currentTrack else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPMediaItemPropertyPlaybackDuration: currentDuration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentPosition,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: max(0, index),
            MPNowPlayingInfoPropertyPlaybackQueueCount: queue.count,
        ]
        if let album = track.album { info[MPMediaItemPropertyAlbumTitle] = album }
        if let art = artworkCache[track.id] { info[MPMediaItemPropertyArtwork] = art }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if artworkCache[track.id] == nil { loadArtwork(for: track) }
    }

    /// Cheap path for the twice-a-second tick: only the moving fields.
    private func refreshNowPlayingTime() {
        guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else {
            updateNowPlaying(); return
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentPosition
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        info[MPMediaItemPropertyPlaybackDuration] = currentDuration
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtwork(for track: SJTrack) {
        // A downloaded track carries its artwork locally so the car shows a
        // cover with no network at all.
        if let entry = SJDownloadStore.shared.entry(for: track.id),
           let artURL = SJDownloadStore.shared.artworkURL(for: entry),
           let data = try? Data(contentsOf: artURL),
           let image = UIImage(data: data) {
            cacheArtwork(image, for: track)
            return
        }
        guard let remote = track.artworkURL else { return }
        URLSession.shared.dataTask(with: remote) { [weak self] data, _, _ in
            guard let self, let data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async { self.cacheArtwork(image, for: track) }
        }.resume()
    }

    /// Covers arrived after the fact (a backfill). Drop what was cached from
    /// before so the now-playing entry and the CarPlay list pick the new ones up
    /// rather than holding a placeholder until the next track change.
    func artworkDidChange() {
        artworkCache.removeAll()
        if let track = currentTrack { loadArtwork(for: track) }
        onQueueChanged?()
    }

    private func cacheArtwork(_ image: UIImage, for track: SJTrack) {
        let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        artworkCache[track.id] = art
        if currentTrack?.id == track.id { updateNowPlaying() }
    }

    // MARK: - Remote commands

    private func configureRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()

        c.playCommand.addTarget { [weak self] _ in
            self?.play(); self?.report("play"); return .success
        }
        c.pauseCommand.addTarget { [weak self] _ in
            self?.pause(); self?.report("pause"); return .success
        }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.togglePlayPause(); self?.report("togglePlayPause"); return .success
        }
        c.nextTrackCommand.addTarget { [weak self] _ in
            self?.next(); self?.report("next"); return .success
        }
        c.previousTrackCommand.addTarget { [weak self] _ in
            self?.previous(); self?.report("previous"); return .success
        }
        c.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(to: e.positionTime); self?.report("seek"); return .success
        }
        [c.skipForwardCommand, c.skipBackwardCommand].forEach { $0.isEnabled = false }
    }

    private func report(_ command: String) {
        delegate?.audioEngine(self, didReceiveRemoteCommand: command, trackId: currentTrack?.id)
    }
}
