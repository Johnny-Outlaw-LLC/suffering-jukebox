import CarPlay
import Foundation
import UIKit

/// The CarPlay app.
///
/// CarPlay cannot render the web UI, and it will not stream YouTube, so what
/// the car sees is the offline locker: tracks the listener downloaded, browsable
/// by artist and album. That is a hard constraint, not a first cut - a CarPlay
/// audio app may only present its own playable content.
@objc(SJCarPlaySceneDelegate)
class SJCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didConnect controller: CPInterfaceController) {
        interfaceController = controller
        controller.setRootTemplate(makeRootTemplate(), animated: false, completion: nil)

        // Downloads finishing mid-drive should show up without a reconnect.
        SJAudioEngine.shared.onQueueChanged = { [weak self] in
            self?.refreshRoot()
        }
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController controller: CPInterfaceController) {
        interfaceController = nil
        SJAudioEngine.shared.onQueueChanged = nil
    }

    // MARK: - Templates

    private func refreshRoot() {
        guard let root = interfaceController?.rootTemplate as? CPListTemplate else { return }
        root.updateSections(makeRootSections())
    }

    private func makeRootTemplate() -> CPListTemplate {
        let template = CPListTemplate(title: "Suffering Jukebox", sections: makeRootSections())
        template.tabTitle = "Library"
        template.tabImage = UIImage(systemName: "music.note.list")
        return template
    }

    private func makeRootSections() -> [CPListSection] {
        let downloads = SJDownloadStore.shared.all()
        guard !downloads.isEmpty else {
            let empty = CPListItem(
                text: "Nothing downloaded yet",
                detailText: "Download tracks in the app to play them here."
            )
            empty.isEnabled = false
            return [CPListSection(items: [empty])]
        }

        // Group by artist so a real library stays navigable on a car screen,
        // where the list limit is small and scrolling is restricted while moving.
        let byArtist = Dictionary(grouping: downloads) { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }
        return byArtist.keys.sorted().map { artist in
            let entries = byArtist[artist]!
            let items = entries.map { entry -> CPListItem in
                let item = CPListItem(text: entry.title, detailText: entry.album)
                item.handler = { [weak self] _, completion in
                    self?.playFromLibrary(startingAt: entry, in: entries)
                    completion()
                }
                if let art = SJDownloadStore.shared.artworkURL(for: entry),
                   let data = try? Data(contentsOf: art),
                   let image = UIImage(data: data) {
                    item.setImage(image)
                }
                return item
            }
            return CPListSection(items: items, header: artist, sectionIndexTitle: String(artist.prefix(1)))
        }
    }

    // MARK: - Playback

    private func playFromLibrary(startingAt entry: SJDownloadStore.Entry,
                                 in entries: [SJDownloadStore.Entry]) {
        let tracks = entries.map { e in
            SJTrack(id: e.trackId,
                    title: e.title,
                    artist: e.artist,
                    album: e.album,
                    artworkURL: nil,          // artwork is on disk; the engine finds it
                    url: nil,                 // downloaded only - no network in the car
                    durationSeconds: e.durationSeconds)
        }
        let start = entries.firstIndex { $0.trackId == entry.trackId } ?? 0
        SJAudioEngine.shared.setQueue(tracks, startIndex: start, autoPlay: true)
        interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }
}
