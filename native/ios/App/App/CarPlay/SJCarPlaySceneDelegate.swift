import CarPlay
import Foundation
import UIKit

/// The CarPlay app.
///
/// CarPlay cannot render the web UI, and it will not stream YouTube, so what
/// the car sees is the offline locker: tracks the listener downloaded, browsable
/// by artist, playlist or song. That is a hard constraint, not a first cut - a
/// CarPlay audio app may only present its own playable content.
///
/// The three tabs deliberately mirror the site's Explore Artists / Explore
/// Playlists / Explore Songs, so the car is a narrower view of a familiar shape
/// rather than a second, differently-organised app.
@objc(SJCarPlaySceneDelegate)
class SJCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?
    private var artistsTab: CPListTemplate?
    private var playlistsTab: CPListTemplate?
    private var songsTab: CPListTemplate?

    /// CarPlay refuses a list longer than this, and the limit is a hard error
    /// rather than a truncation, so every section is clamped before it is handed
    /// over. A locker large enough to hit it is browsed by artist anyway.
    private var itemLimit: Int { CPListTemplate.maximumItemCount }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didConnect controller: CPInterfaceController) {
        interfaceController = controller
        controller.setRootTemplate(makeTabBar(), animated: false, completion: nil)

        // Downloads finishing mid-drive should show up without a reconnect.
        SJAudioEngine.shared.onQueueChanged = { [weak self] in
            DispatchQueue.main.async { self?.refreshTabs() }
        }
        SJAudioEngine.shared.onTrackChanged = { [weak self] _ in
            DispatchQueue.main.async { self?.refreshNowPlayingButtons() }
        }
        refreshNowPlayingButtons()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController controller: CPInterfaceController) {
        interfaceController = nil
        artistsTab = nil
        playlistsTab = nil
        songsTab = nil
        SJAudioEngine.shared.onQueueChanged = nil
        SJAudioEngine.shared.onTrackChanged = nil
    }

    // MARK: - Templates

    private func makeTabBar() -> CPTemplate {
        let artists = CPListTemplate(title: "Artists", sections: artistSections())
        artists.tabTitle = "Artists"
        artists.tabImage = UIImage(systemName: "music.mic")

        let playlists = CPListTemplate(title: "Playlists", sections: playlistSections())
        playlists.tabTitle = "Playlists"
        playlists.tabImage = UIImage(systemName: "music.note.list")

        let songs = CPListTemplate(title: "Songs", sections: songSections())
        songs.tabTitle = "Songs"
        songs.tabImage = UIImage(systemName: "music.note")

        artistsTab = artists
        playlistsTab = playlists
        songsTab = songs

        return CPTabBarTemplate(templates: [artists, playlists, songs])
    }

    private func refreshTabs() {
        artistsTab?.updateSections(artistSections())
        playlistsTab?.updateSections(playlistSections())
        songsTab?.updateSections(songSections())
    }

    private func emptySection(_ text: String, _ detail: String) -> [CPListSection] {
        let item = CPListItem(text: text, detailText: detail)
        item.isEnabled = false
        return [CPListSection(items: [item])]
    }

    private static let nothingDownloaded = (
        "Nothing downloaded yet",
        "Pick songs on sufferingjukebox.stream, then accept them in the app."
    )

    // MARK: - Artists

    /// One row per artist, opening that artist's songs - rather than every song
    /// under a header, which is what the single list used to be. A locker of any
    /// size is unreadable in a car if the first screen is 400 titles.
    private func artistSections() -> [CPListSection] {
        let downloads = SJDownloadStore.shared.all()
        guard !downloads.isEmpty else {
            return emptySection(Self.nothingDownloaded.0, Self.nothingDownloaded.1)
        }
        let byArtist = Dictionary(grouping: downloads) { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }
        let items = byArtist.keys.sorted().prefix(itemLimit).map { artist -> CPListItem in
            let entries = sorted(byArtist[artist] ?? [])
            let item = CPListItem(text: artist, detailText: songCount(entries.count))
            item.setImage(artwork(for: entries.first))
            item.handler = { [weak self] _, completion in
                self?.pushSongList(title: artist, entries: entries)
                completion()
            }
            return item
        }
        return [CPListSection(items: Array(items))]
    }

    // MARK: - Playlists

    private func playlistSections() -> [CPListSection] {
        let playable = SJPlaylistStore.shared.playable()
        guard !playable.isEmpty else {
            return emptySection(
                "No playlists on this iPhone",
                SJDownloadStore.shared.all().isEmpty
                    ? Self.nothingDownloaded.1
                    : "Download some of a playlist's songs and it will appear here."
            )
        }
        let items = playable.prefix(itemLimit).map { entry -> CPListItem in
            let (playlist, entries) = entry
            // Kept in the saved running order, not re-sorted: a playlist is a
            // sequence, and alphabetising it would quietly destroy the point.
            let item = CPListItem(text: playlist.name, detailText: songCount(entries.count))
            item.setImage(artwork(for: entries.first))
            item.handler = { [weak self] _, completion in
                self?.pushSongList(title: playlist.name, entries: entries, preserveOrder: true)
                completion()
            }
            return item
        }
        return [CPListSection(items: Array(items))]
    }

    // MARK: - Songs

    private func songSections() -> [CPListSection] {
        let downloads = sorted(SJDownloadStore.shared.all())
        guard !downloads.isEmpty else {
            return emptySection(Self.nothingDownloaded.0, Self.nothingDownloaded.1)
        }
        return [CPListSection(items: listItems(for: Array(downloads.prefix(itemLimit)),
                                              in: downloads,
                                              showArtist: true))]
    }

    // MARK: - Shared list plumbing

    private func pushSongList(title: String,
                              entries: [SJDownloadStore.Entry],
                              preserveOrder: Bool = false) {
        let ordered = preserveOrder ? entries : sorted(entries)
        let section = CPListSection(items: listItems(for: Array(ordered.prefix(itemLimit)),
                                                    in: ordered,
                                                    showArtist: false))
        let template = CPListTemplate(title: title, sections: [section])
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }

    private func listItems(for shown: [SJDownloadStore.Entry],
                           in queue: [SJDownloadStore.Entry],
                           showArtist: Bool) -> [CPListItem] {
        shown.map { entry in
            let detail = showArtist
                ? [entry.artist, entry.album ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                : (entry.album ?? "")
            let item = CPListItem(text: entry.title, detailText: detail.isEmpty ? nil : detail)
            item.setImage(artwork(for: entry))
            item.handler = { [weak self] _, completion in
                self?.play(startingAt: entry, in: queue)
                completion()
            }
            return item
        }
    }

    private func sorted(_ entries: [SJDownloadStore.Entry]) -> [SJDownloadStore.Entry] {
        entries.sorted { ($0.album ?? "", $0.title) < ($1.album ?? "", $1.title) }
    }

    private func songCount(_ n: Int) -> String { "\(n) song\(n == 1 ? "" : "s")" }

    /// Covers come off disk, already fetched at download time. Decoding on the
    /// main thread is what makes a long list stutter, so results are cached and
    /// the image is scaled down to the row size CarPlay actually draws.
    private var artworkCache: [String: UIImage] = [:]

    private func artwork(for entry: SJDownloadStore.Entry?) -> UIImage? {
        guard let entry else { return nil }
        if let cached = artworkCache[entry.trackId] { return cached }
        guard let url = SJDownloadStore.shared.artworkURL(for: entry),
              let data = try? Data(contentsOf: url),
              let image = UIImage(data: data) else { return nil }
        let side: CGFloat = 60
        let scaled = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        artworkCache[entry.trackId] = scaled
        return scaled
    }

    // MARK: - Rating and reactions

    /// Two buttons on the Now Playing screen: a thumbs-up that toggles the
    /// track's rating, and a heart that stamps the moment being listened to.
    ///
    /// A tap goes to disk before anything else (SJFeedbackOutbox). The web layer
    /// owns what a rating means and does the actual sending, but in a car it may
    /// be suspended and is often offline, so a straight bridge call would drop
    /// presses silently. The button redraws from the outbox immediately, so it
    /// reflects the tap whether or not anything has been sent yet.
    private func refreshNowPlayingButtons() {
        guard let trackId = SJAudioEngine.shared.currentTrack?.id else {
            CPNowPlayingTemplate.shared.updateNowPlayingButtons([])
            return
        }
        let rated = isRated(trackId)
        let thumb = CPNowPlayingImageButton(
            image: symbol(rated ? "hand.thumbsup.fill" : "hand.thumbsup")
        ) { [weak self] _ in
            self?.tapRating(trackId: trackId)
        }
        let heart = CPNowPlayingImageButton(image: symbol("heart")) { [weak self] _ in
            self?.tapHeart(trackId: trackId)
        }
        CPNowPlayingTemplate.shared.updateNowPlayingButtons([thumb, heart])
    }

    /// What the web layer last told us, overlaid with anything tapped in the car
    /// that it has not absorbed yet - so the car's own taps always win on screen.
    private func isRated(_ trackId: String) -> Bool {
        if let pending = SJFeedbackOutbox.shared.pendingRatings()[trackId] { return pending > 0 }
        return SJCarPlayFeedback.shared.ratedTrackIds.contains(trackId)
    }

    private func tapRating(trackId: String) {
        let next = isRated(trackId) ? 0 : 1
        SJFeedbackOutbox.shared.add(kind: "rate", trackId: trackId, value: next, positionMs: 0)
        refreshNowPlayingButtons()
        SJCarPlayFeedback.shared.onChange?()
    }

    private func tapHeart(trackId: String) {
        // Every press is an event stamped with the moment in the song, matching
        // the site - not a toggle, so there is no state to show back.
        let ms = Int(SJAudioEngine.shared.status().positionSeconds * 1000)
        SJFeedbackOutbox.shared.add(kind: "heart", trackId: trackId, value: 0, positionMs: max(0, ms))
        SJCarPlayFeedback.shared.onChange?()
    }

    private func symbol(_ name: String) -> UIImage {
        let config = UIImage.SymbolConfiguration(pointSize: 40, weight: .regular)
        return UIImage(systemName: name, withConfiguration: config) ?? UIImage()
    }

    // MARK: - Playback

    private func play(startingAt entry: SJDownloadStore.Entry,
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
