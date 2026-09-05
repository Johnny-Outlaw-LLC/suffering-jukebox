import Capacitor
import Foundation
import UIKit

/// Bridges the web UI to the native engine. Deliberately thin: policy lives in
/// SJAudioEngine so CarPlay, which never touches this class, behaves identically.
@objc(SJNativeAudio)
public class SJNativeAudio: CAPPlugin, CAPBridgedPlugin, SJAudioEngineDelegate {

    public let identifier = "SJNativeAudio"
    public let jsName = "SJNativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setQueue",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDownloads",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backfillArtwork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaylists",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRatedTracks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainFeedback",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackFeedback",    returnType: CAPPluginReturnPromise),
    ]

    private var engine: SJAudioEngine { SJAudioEngine.shared }

    override public func load() {
        engine.delegate = self
        // A tap in the car should reach the server while the drive is still
        // happening when it can, rather than waiting for the next cold start.
        SJCarPlayFeedback.shared.onChange = { [weak self] in
            self?.notifyListeners("carplayFeedback", data: ["pending": SJFeedbackOutbox.shared.pending().count])
        }
    }

    // MARK: - Transport

    @objc func setQueue(_ call: CAPPluginCall) {
        let raw = call.getArray("tracks", JSObject.self) ?? []
        let tracks = raw.compactMap(Self.track(from:))
        let startIndex = call.getInt("startIndex") ?? 0
        let autoPlay = call.getBool("autoPlay") ?? false
        DispatchQueue.main.async {
            self.engine.setQueue(tracks, startIndex: startIndex, autoPlay: autoPlay)
            call.resolve(Self.dict(self.engine.status()))
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.engine.play(index: call.getInt("index"))
            call.resolve(Self.dict(self.engine.status()))
        }
    }

    @objc func pause(_ call: CAPPluginCall) { run(call) { self.engine.pause() } }
    @objc func next(_ call: CAPPluginCall) { run(call) { self.engine.next() } }
    @objc func previous(_ call: CAPPluginCall) { run(call) { self.engine.previous() } }

    @objc func seek(_ call: CAPPluginCall) {
        guard let pos = call.getDouble("positionSeconds") else {
            call.reject("positionSeconds is required"); return
        }
        run(call) { self.engine.seek(to: pos) }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(Self.dict(self.engine.status())) }
    }

    private func run(_ call: CAPPluginCall, _ body: @escaping () -> Void) {
        DispatchQueue.main.async {
            body()
            call.resolve(Self.dict(self.engine.status()))
        }
    }

    // MARK: - Downloads

    @objc func download(_ call: CAPPluginCall) {
        guard let obj = call.getObject("track"), let track = Self.track(from: obj) else {
            call.reject("track is required"); return
        }
        guard let remote = track.url else {
            call.reject("track has no signed url to download from"); return
        }
        if SJDownloadStore.shared.isDownloaded(track.id) {
            call.resolve(Self.downloadDict(trackId: track.id, state: "done", progress: 1,
                                           bytes: SJDownloadStore.shared.entry(for: track.id)?.bytes ?? 0))
            return
        }

        SJDownloader.shared.download(track: track, from: remote, progress: { [weak self] fraction in
            self?.notifyListeners("downloadChange", data: Self.downloadDict(
                trackId: track.id, state: "downloading", progress: fraction, bytes: 0))
        }, completion: { [weak self] result in
            switch result {
            case .success(let bytes):
                let payload = Self.downloadDict(trackId: track.id, state: "done", progress: 1, bytes: bytes)
                self?.notifyListeners("downloadChange", data: payload)
            case .failure(let error):
                var payload = Self.downloadDict(trackId: track.id, state: "failed", progress: 0, bytes: 0)
                payload["error"] = error.localizedDescription
                self?.notifyListeners("downloadChange", data: payload)
            }
        })

        call.resolve(Self.downloadDict(trackId: track.id, state: "downloading", progress: 0, bytes: 0))
    }

    @objc func removeDownload(_ call: CAPPluginCall) {
        guard let id = call.getString("trackId") else { call.reject("trackId is required"); return }
        SJDownloadStore.shared.remove(trackId: id)
        notifyListeners("downloadChange", data: Self.downloadDict(trackId: id, state: "none", progress: 0, bytes: 0))
        call.resolve()
    }

    @objc func listDownloads(_ call: CAPPluginCall) {
        let downloads = SJDownloadStore.shared.all().map { entry -> JSObject in
            var dict = Self.downloadDict(trackId: entry.trackId, state: "done", progress: 1, bytes: entry.bytes)
            // Lets the web layer find the covers worth repairing without
            // shipping the whole index across the bridge.
            dict["hasArtwork"] = SJDownloadStore.shared.artworkURL(for: entry)
                .map { FileManager.default.fileExists(atPath: $0.path) } ?? false
            return dict
        }
        call.resolve(["downloads": downloads, "bytesUsed": Int(SJDownloadStore.shared.bytesUsed())])
    }

    /// Fetch covers for tracks that were downloaded before the metadata
    /// pipeline carried album art. Images only - the audio is already on disk,
    /// and nobody should re-download an album to fix a thumbnail.
    @objc func backfillArtwork(_ call: CAPPluginCall) {
        let raw = call.getArray("tracks", JSObject.self) ?? []
        let wanted: [(String, URL)] = raw.compactMap { obj in
            guard let id = obj["trackId"] as? String,
                  let urlString = obj["artworkUrl"] as? String,
                  let url = URL(string: urlString) else { return nil }
            // Already repaired, or never downloaded: nothing to do either way.
            guard let entry = SJDownloadStore.shared.entry(for: id) else { return nil }
            if let art = SJDownloadStore.shared.artworkURL(for: entry),
               FileManager.default.fileExists(atPath: art.path) { return nil }
            return (id, url)
        }
        guard !wanted.isEmpty else { call.resolve(["repaired": 0]); return }

        let group = DispatchGroup()
        let lock = NSLock()
        var repaired = 0
        for (id, url) in wanted {
            group.enter()
            URLSession.shared.dataTask(with: url) { data, response, _ in
                defer { group.leave() }
                guard let data, !data.isEmpty,
                      (response as? HTTPURLResponse)?.statusCode ?? 200 < 400,
                      UIImage(data: data) != nil else { return }
                if SJDownloadStore.shared.attachArtwork(data, trackId: id) {
                    lock.lock(); repaired += 1; lock.unlock()
                }
            }.resume()
        }
        group.notify(queue: .main) {
            // A repaired cover should appear without waiting for a reconnect.
            if repaired > 0 { SJAudioEngine.shared.artworkDidChange() }
            call.resolve(["repaired": repaired])
        }
    }

    // MARK: - Playlists

    /// Hand CarPlay the running orders. The car cannot reach the web layer once
    /// it is driving, so this is pushed whenever playlists change rather than
    /// pulled when the Playlists tab is opened.
    @objc func setPlaylists(_ call: CAPPluginCall) {
        let raw = call.getArray("playlists", JSObject.self) ?? []
        let playlists: [SJPlaylistStore.Playlist] = raw.compactMap { obj in
            guard let id = obj["id"] as? String, let name = obj["name"] as? String else { return nil }
            let ids = (obj["trackIds"] as? [Any])?.compactMap { $0 as? String } ?? []
            return SJPlaylistStore.Playlist(id: id, name: name, trackIds: ids)
        }
        SJPlaylistStore.shared.replaceAll(playlists)
        DispatchQueue.main.async {
            SJAudioEngine.shared.onQueueChanged?()   // repaint the car's list
            call.resolve(["count": playlists.count])
        }
    }

    // MARK: - Car feedback

    /// Which downloaded tracks are already rated, so the car's thumb draws
    /// filled. Pushed from the web layer, which owns what a rating means.
    @objc func setRatedTracks(_ call: CAPPluginCall) {
        let ids = (call.getArray("trackIds") as? [String]) ?? []
        SJCarPlayFeedback.shared.setRated(ids)
        call.resolve(["count": ids.count])
    }

    /// Ratings and hearts tapped in the car, for the web layer to send on.
    /// Nothing is removed here - only an explicit ack drops an item, so a drain
    /// that fails to reach the server is retried rather than lost.
    @objc func drainFeedback(_ call: CAPPluginCall) {
        let items: [JSObject] = SJFeedbackOutbox.shared.pending().map { item in
            [
                "id": item.id,
                "kind": item.kind,
                "trackId": item.trackId,
                "value": item.value,
                "positionMs": item.positionMs,
                "at": item.at,
            ]
        }
        call.resolve(["items": items])
    }

    @objc func ackFeedback(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") as? [String]) ?? []
        SJFeedbackOutbox.shared.acknowledge(ids: ids)
        call.resolve(["remaining": SJFeedbackOutbox.shared.pending().count])
    }

    // MARK: - Engine delegate

    func audioEngine(_ engine: SJAudioEngine, didChange status: SJStatus) {
        notifyListeners("statusChange", data: Self.dict(status))
    }

    func audioEngine(_ engine: SJAudioEngine, didReceiveRemoteCommand command: String, trackId: String?) {
        notifyListeners("remoteCommand", data: ["command": command, "trackId": trackId ?? NSNull()])
    }

    // MARK: - Mapping

    private static func track(from obj: JSObject) -> SJTrack? {
        guard let id = obj["id"] as? String,
              let title = obj["title"] as? String else { return nil }
        return SJTrack(
            id: id,
            title: title,
            artist: obj["artist"] as? String ?? "",
            album: obj["album"] as? String,
            artworkURL: (obj["artworkUrl"] as? String).flatMap(URL.init(string:)),
            url: (obj["url"] as? String).flatMap(URL.init(string:)),
            durationSeconds: obj["durationSeconds"] as? Double ?? 0
        )
    }

    private static func dict(_ s: SJStatus) -> JSObject {
        [
            "state": s.state.rawValue,
            "index": s.index,
            "trackId": s.trackId ?? NSNull(),
            "positionSeconds": s.positionSeconds,
            "durationSeconds": s.durationSeconds,
        ]
    }

    private static func downloadDict(trackId: String, state: String, progress: Double, bytes: Int64) -> JSObject {
        // JSValue has no Int64; Int is 64-bit on every device we ship to.
        ["trackId": trackId, "state": state, "progress": progress, "bytes": Int(bytes)]
    }
}
