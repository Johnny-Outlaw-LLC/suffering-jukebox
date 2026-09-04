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

    private let player = AVPlayer()
    private(set) var queue: [SJTrack] = []
    private(set) var index: Int = -1
    private var timeObserver: Any?
    private var itemEndObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var artworkCache: [String: MPMediaItemArtwork] = [:]

    private override init() {
        super.init()
        configureSession()
        configureRemoteCommands()
        observePlayer()
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

    /// Replaces the queue. If the track playing right now survives into the new
    /// queue, playback continues untouched and only the index moves - that is
    /// what lets the web layer refresh expiring signed URLs mid-song.
    func setQueue(_ tracks: [SJTrack], startIndex: Int, autoPlay: Bool) {
        let playingId = currentTrack?.id
        queue = tracks

        if let playingId, let stillThere = tracks.firstIndex(where: { $0.id == playingId }) {
            index = stillThere
            updateNowPlaying()
            onQueueChanged?()
            publish()
            return
        }

        let target = tracks.isEmpty ? -1 : max(0, min(startIndex, tracks.count - 1))
        index = target
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
            if obs.status == .failed { self.advance() } else { self.publish() }
        }
        if autoPlay { player.play() }
        updateNowPlaying()
        publish()
    }

    private func advance() {
        if index + 1 < queue.count {
            load(at: index + 1, autoPlay: true)
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

    func next() { advance() }

    /// Matches every other music player: restart the track unless you are
    /// already near the top, in which case go back one.
    func previous() {
        if currentPosition > 3, player.currentItem != nil {
            seek(to: 0)
        } else if index > 0 {
            load(at: index - 1, autoPlay: true)
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
