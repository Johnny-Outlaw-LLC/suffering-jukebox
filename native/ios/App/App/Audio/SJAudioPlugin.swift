import Capacitor
import Foundation

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
    ]

    private var engine: SJAudioEngine { SJAudioEngine.shared }

    override public func load() {
        engine.delegate = self
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
        let downloads = SJDownloadStore.shared.all().map {
            Self.downloadDict(trackId: $0.trackId, state: "done", progress: 1, bytes: $0.bytes)
        }
        call.resolve(["downloads": downloads, "bytesUsed": Int(SJDownloadStore.shared.bytesUsed())])
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
