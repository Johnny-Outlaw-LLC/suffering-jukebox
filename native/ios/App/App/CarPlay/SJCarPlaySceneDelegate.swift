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
class SJCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate, CPNowPlayingTemplateObserver {

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

        CPNowPlayingTemplate.shared.add(self)
        CPNowPlayingTemplate.shared.isUpNextButtonEnabled = true
        refreshUpNextTitle()

        // Downloads finishing mid-drive should show up without a reconnect.
        SJAudioEngine.shared.onQueueChanged = { [weak self] in
            DispatchQueue.main.async {
                self?.refreshTabs()
                self?.refreshUpNextTitle()
            }
        }
        SJAudioEngine.shared.onTrackChanged = { [weak self] _ in
            DispatchQueue.main.async {
                self?.refreshNowPlayingButtons()
                self?.refreshUpNextTitle()
            }
        }
        // Shuffle, repeat, a fresh rating or a fresh heart count all redraw the
        // same button row without the track changing underneath it. Shuffle and
        // repeat also change what plays next, so the Up Next button's own
        // label needs the same refresh.
        SJAudioEngine.shared.onModeChanged = { [weak self] in
            DispatchQueue.main.async {
                self?.refreshNowPlayingButtons()
                self?.refreshUpNextTitle()
            }
        }
        refreshNowPlayingButtons()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController controller: CPInterfaceController) {
        interfaceController = nil
        artistsTab = nil
        playlistsTab = nil
        songsTab = nil
        CPNowPlayingTemplate.shared.remove(self)
        SJAudioEngine.shared.onQueueChanged = nil
        SJAudioEngine.shared.onTrackChanged = nil
        SJAudioEngine.shared.onModeChanged = nil
    }

    // MARK: - Now Playing: Up Next

    /// The queue that produced whatever is playing now, shown so the driver
    /// can see what is coming or jump ahead - the same list Artists, Playlists
    /// and Songs already built to start playback, just framed as "what plays
    /// next" instead of "what to start playing."
    func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
        let engine = SJAudioEngine.shared
        let queue = engine.queue
        guard !queue.isEmpty else { return }
        let items = queue.enumerated().prefix(itemLimit).map { (i, track) -> CPListItem in
            let item = CPListItem(text: track.title, detailText: track.artist)
            item.setImage(artwork(forTrackId: track.id))
            item.isPlaying = (i == engine.index)
            item.handler = { [weak self] _, completion in
                SJAudioEngine.shared.play(index: i)
                // Up Next was pushed on top of Now Playing, so returning to it
                // is a pop, not another push of the (singleton) template.
                self?.interfaceController?.popTemplate(animated: true, completion: nil)
                completion()
            }
            return item
        }
        let template = CPListTemplate(title: "Up Next", sections: [CPListSection(items: items)])
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }

    /// The button itself names the next track, rather than a generic "Up
    /// Next" label that only means something once tapped - so the driver
    /// sees what's coming without opening the queue.
    private func refreshUpNextTitle() {
        guard let next = SJAudioEngine.shared.nextTrack else {
            CPNowPlayingTemplate.shared.upNextTitle = "Up Next"
            return
        }
        let title = next.title
        let truncated = title.count > 30 ? String(title.prefix(30)) + "…" : title
        CPNowPlayingTemplate.shared.upNextTitle = "NEXT: " + truncated
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
        artworkCache.removeAll()
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
            item.setImage(entries.lazy.compactMap { self.artwork(for: $0) }.first)
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
            item.setImage(entries.lazy.compactMap { self.artwork(for: $0) }.first)
            item.handler = { [weak self] _, completion in
                self?.pushSongList(title: playlist.name, entries: entries, preserveOrder: true)
                completion()
            }
            return item
        }
        return [CPListSection(items: Array(items))]
    }

    // MARK: - Songs

    private var songSort: String {
        get { UserDefaults.standard.string(forKey: "sj.carplay.songSort") ?? "Alphabetical" }
        set { UserDefaults.standard.set(newValue, forKey: "sj.carplay.songSort") }
    }

    private func showSongSort() {
        let items = ["By Artist", "By Plays", "Alphabetical"].map { order in
            let item = CPListItem(text: order, detailText: order == songSort ? "Selected" : nil)
            item.handler = { [weak self] _, completion in
                self?.songSort = order
                self?.songsTab?.updateSections(self?.songSections() ?? [])
                self?.interfaceController?.popTemplate(animated: true, completion: nil)
                completion()
            }
            return item
        }
        interfaceController?.pushTemplate(CPListTemplate(title: "Sort Songs", sections: [CPListSection(items: items)]),
                                          animated: true, completion: nil)
    }

    private func songSections() -> [CPListSection] {
        let counts = UserDefaults.standard.dictionary(forKey: "sj.carplay.playCounts") as? [String: Int] ?? [:]
        let downloads = SJDownloadStore.shared.all().sorted { a, b in
            if songSort == "By Plays", counts[a.trackId, default: 0] != counts[b.trackId, default: 0] {
                return counts[a.trackId, default: 0] > counts[b.trackId, default: 0]
            }
            if songSort == "By Artist" {
                let artist = a.artist.localizedStandardCompare(b.artist)
                if artist != .orderedSame { return artist == .orderedAscending }
            }
            let title = a.title.localizedStandardCompare(b.title)
            return title == .orderedSame ? a.trackId < b.trackId : title == .orderedAscending
        }
        guard !downloads.isEmpty else {
            return emptySection(Self.nothingDownloaded.0, Self.nothingDownloaded.1)
        }
        let sort = CPListItem(text: "Sort: " + songSort, detailText: nil)
        sort.handler = { [weak self] _, completion in
            self?.showSongSort()
            completion()
        }
        return [CPListSection(items: [shuffleItem(for: downloads), sort] + listItems(for: Array(downloads.prefix(max(0, itemLimit - 2))),
                                                       in: downloads, showArtist: true))]
    }

    // MARK: - Shared list plumbing

    private func pushSongList(title: String,
                              entries: [SJDownloadStore.Entry],
                              preserveOrder: Bool = false) {
        let ordered = preserveOrder ? entries : sorted(entries)
        let section = CPListSection(items: [shuffleItem(for: ordered)] + listItems(for: Array(ordered.prefix(max(0, itemLimit - 1))),
                                                    in: ordered,
                                                    showArtist: false))
        let template = CPListTemplate(title: title, sections: [section])
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }

    private func shuffleItem(for entries: [SJDownloadStore.Entry]) -> CPListItem {
        let item = CPListItem(text: "Shuffle All", detailText: songCount(entries.count))
        item.setImage(UIImage(systemName: "shuffle"))
        item.isEnabled = !entries.isEmpty
        item.handler = { [weak self] _, completion in
            // The first song is drawn with the listener's own weights too, not
            // at random - otherwise Shuffle All ignores the preference for
            // exactly the song they are most likely to notice.
            let profile = SJShuffleProfile.shared
            let first: SJDownloadStore.Entry?
            if profile.isWeighted, !entries.isEmpty {
                let total = entries.reduce(0.0) { $0 + profile.weight(for: $1.trackId) }
                var roll = Double.random(in: 0..<max(total, .leastNonzeroMagnitude))
                var chosen = entries.last
                for entry in entries {
                    roll -= profile.weight(for: entry.trackId)
                    if roll <= 0 { chosen = entry; break }
                }
                first = chosen
            } else {
                first = entries.randomElement()
            }
            if let first {
                let engine = SJAudioEngine.shared
                // Repeat One must not trap Shuffle All on its first song.
                if engine.repeatMode == .one { engine.cycleRepeatMode() }
                engine.setShuffle(true)
                self?.play(startingAt: first, in: entries)
            }
            completion()
        }
        return item
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
            // Not every stored cover is square. Scale to fill the row's square
            // slot and let the longer side run off the edges (object-fit:
            // cover), rather than stretching the source into a square, which
            // is what made some covers look squashed.
            let size = image.size
            guard size.width > 0, size.height > 0 else {
                image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
                return
            }
            let fillScale = max(side / size.width, side / size.height)
            let w = size.width * fillScale
            let h = size.height * fillScale
            image.draw(in: CGRect(x: (side - w) / 2, y: (side - h) / 2, width: w, height: h))
        }
        artworkCache[entry.trackId] = scaled
        return scaled
    }

    /// Up Next works from the live queue (SJTrack), not the download index, so
    /// it needs its cover by id rather than by SJDownloadStore.Entry.
    private func artwork(forTrackId trackId: String) -> UIImage? {
        artwork(for: SJDownloadStore.shared.entry(for: trackId))
    }

    // MARK: - Rating and reactions

    /// Four buttons on the Now Playing screen: shuffle and repeat for the
    /// queue, a thumbs-up that toggles the track's rating (drawn green once
    /// awarded), and a heart that stamps the moment being listened to (drawn
    /// red with a count once the track has any).
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
        let engine = SJAudioEngine.shared

        let shuffle = CPNowPlayingImageButton(
            image: symbol("shuffle", color: engine.shuffleEnabled ? .systemGreen : nil)
        ) { _ in
            SJAudioEngine.shared.setShuffle(!SJAudioEngine.shared.shuffleEnabled)
        }

        shuffle.isSelected = engine.shuffleEnabled

        let rated = isRated(trackId)
        let thumb = CPNowPlayingImageButton(
            image: symbol(rated ? "hand.thumbsup.fill" : "hand.thumbsup", color: rated ? .systemGreen : nil)
        ) { [weak self] _ in
            self?.tapRating(trackId: trackId)
        }

        thumb.isSelected = rated

        let heart = CPNowPlayingImageButton(image: heartImage(count: heartCount(trackId))) { [weak self] _ in
            self?.tapHeart(trackId: trackId)
        }

        let repeatMode = engine.repeatMode
        let repeatIcon = repeatMode == .one ? "repeat.1" : "repeat"
        let repeatBtn = CPNowPlayingImageButton(
            image: symbol(repeatIcon, color: repeatMode == .off ? nil : .systemGreen)
        ) { _ in
            SJAudioEngine.shared.cycleRepeatMode()
        }

        repeatBtn.isSelected = repeatMode != .off
        CPNowPlayingTemplate.shared.updateNowPlayingButtons([shuffle, thumb, heart, repeatBtn])
    }

    /// What the web layer last told us, overlaid with anything tapped in the car
    /// that it has not absorbed yet - so the car's own taps always win on screen.
    private func isRated(_ trackId: String) -> Bool {
        if let pending = SJFeedbackOutbox.shared.pendingRatings()[trackId] { return pending > 0 }
        return SJCarPlayFeedback.shared.ratedTrackIds.contains(trackId)
    }

    /// The server's count, plus anything hearted in the car this session that
    /// has not been sent yet - so a tap bumps the badge immediately instead of
    /// waiting on a drain and a round trip.
    private func heartCount(_ trackId: String) -> Int {
        let pending = SJFeedbackOutbox.shared.pending()
            .filter { $0.kind == "heart" && $0.trackId == trackId }.count
        return SJCarPlayFeedback.shared.heartCount(for: trackId) + pending
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
        refreshNowPlayingButtons()
        SJCarPlayFeedback.shared.onChange?()
    }

    // CarPlay retints these images from their alpha channel. Keep the canvas
    // transparent and fit every glyph without changing its aspect ratio.
    private func buttonImage(_ draw: (CGContext, CGSize) -> Void) -> UIImage {
        let size = CPNowPlayingButtonMaximumImageSize
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        format.scale = interfaceController?.carTraitCollection.displayScale ?? 2
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            draw(context.cgContext, size)
        }.withRenderingMode(.alwaysTemplate)
    }

    private func drawSymbol(_ name: String, in rect: CGRect) {
        guard let image = UIImage(systemName: name,
                                  withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .regular))?.withTintColor(.white, renderingMode: .alwaysOriginal) else { return }
        let scale = min(rect.width / image.size.width, rect.height / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        image.draw(in: CGRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2,
                              width: size.width, height: size.height))
    }

    private func symbol(_ name: String, color: UIColor? = nil) -> UIImage {
        buttonImage { _, size in
            self.drawSymbol(name, in: CGRect(origin: .zero, size: size).insetBy(dx: 5, dy: 5))
        }
    }

    /// Knock the digits out of the heart's alpha mask so system tinting cannot
    /// turn the count and its background into one solid rectangle.
    private func heartImage(count: Int) -> UIImage {
        guard count > 0 else { return symbol("heart") }
        return buttonImage { context, size in
            self.drawSymbol("heart.fill", in: CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2))
            let text = count > 99 ? "99+" : "\(count)"
            let font = UIFont.boldSystemFont(ofSize: min(size.width, size.height) * 0.28)
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
            let textSize = (text as NSString).size(withAttributes: attrs)
            context.setBlendMode(.destinationOut)
            (text as NSString).draw(at: CGPoint(x: (size.width - textSize.width) / 2,
                                                y: size.height * 0.43 - textSize.height / 2),
                                   withAttributes: attrs)
        }
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
