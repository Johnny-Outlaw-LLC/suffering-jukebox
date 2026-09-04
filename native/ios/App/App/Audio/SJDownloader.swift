import Foundation
import UIKit

/// Background-capable downloader for locker tracks.
///
/// Uses a background URLSession so a download that was started and then
/// backgrounded still finishes - the common case is queueing an album and
/// putting the phone away before a drive.
final class SJDownloader: NSObject {

    static let shared = SJDownloader()

    private struct Job {
        let track: SJTrack
        let progress: (Double) -> Void
        let completion: (Result<Int64, Error>) -> Void
    }

    private var jobs: [Int: Job] = [:]          // taskIdentifier -> job
    private let lock = NSLock()

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "com.johnnyoutlaw.sufferingjukebox.downloads")
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    private override init() { super.init() }

    func download(track: SJTrack,
                  from url: URL,
                  progress: @escaping (Double) -> Void,
                  completion: @escaping (Result<Int64, Error>) -> Void) {
        let task = session.downloadTask(with: url)
        lock.lock()
        jobs[task.taskIdentifier] = Job(track: track, progress: progress, completion: completion)
        lock.unlock()
        task.resume()
    }

    private func job(for task: URLSessionTask) -> Job? {
        lock.lock(); defer { lock.unlock() }
        return jobs[task.taskIdentifier]
    }

    private func clear(_ task: URLSessionTask) {
        lock.lock(); jobs[task.taskIdentifier] = nil; lock.unlock()
    }
}

extension SJDownloader: URLSessionDownloadDelegate {

    func urlSession(_ session: URLSession,
                    downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0, let job = job(for: downloadTask) else { return }
        let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        DispatchQueue.main.async { job.progress(min(1, max(0, fraction))) }
    }

    func urlSession(_ session: URLSession,
                    downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let job = job(for: downloadTask) else { return }
        let track = job.track

        // The signed URL carries the storage path, so its extension is the real
        // container. Query string has to go before we read it.
        let ext = downloadTask.originalRequest?.url
            .flatMap { URL(string: $0.absoluteString.components(separatedBy: "?")[0]) }?
            .pathExtension ?? "mp3"
        let dest = SJDownloadStore.shared.destination(trackId: track.id, suggestedExtension: ext)

        do {
            try? FileManager.default.removeItem(at: dest)
            // Must move within this callback: the temp file is gone on return.
            try FileManager.default.moveItem(at: location, to: dest)
            let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
            let bytes = (attrs?[.size] as? NSNumber)?.int64Value ?? 0

            var entry = SJDownloadStore.Entry(
                trackId: track.id,
                bytes: bytes,
                fileName: dest.lastPathComponent,
                title: track.title,
                artist: track.artist,
                album: track.album,
                durationSeconds: track.durationSeconds,
                artworkFileName: nil
            )

            // Pull artwork now so the car can show a cover with no network.
            if let artURL = track.artworkURL, let data = try? Data(contentsOf: artURL) {
                entry.artworkFileName = SJDownloadStore.shared.storeArtwork(data, trackId: track.id)
            }

            SJDownloadStore.shared.add(entry)
            DispatchQueue.main.async {
                SJAudioEngine.shared.onQueueChanged?()
                job.completion(.success(entry.bytes))
            }
        } catch {
            DispatchQueue.main.async { job.completion(.failure(error)) }
        }
        clear(downloadTask)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let job = job(for: task) else { return }
        DispatchQueue.main.async { job.completion(.failure(error)) }
        clear(task)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            guard let delegate = UIApplication.shared.delegate as? AppDelegate else { return }
            delegate.backgroundDownloadCompletionHandler?()
            delegate.backgroundDownloadCompletionHandler = nil
        }
    }
}
