import CarPlay
import Foundation
import UIKit

/// The CarPlay app.
///
/// CarPlay cannot render the web UI, and it will not stream YouTube, so what
/// the car sees is real audio files only: songs downloaded to the phone, the
/// listener's own uploads, and every artist-licensed song (SJCarLibrary). The
/// last two stream, so uploading an MP3 is enough to hear it in the car.
/// YouTube-only songs never appear - a CarPlay audio app may only present its
/// own playable content.
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
    private var aboutTab: CPListTemplate?

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

        // Streamable songs come from the server; the list on disk shows
        // immediately and this repaints once a fresh one lands.
        SJStreamLibrary.shared.onChange = { [weak self] in self?.refreshTabs() }
        SJStreamLibrary.shared.refresh()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController controller: CPInterfaceController) {
        interfaceController = nil
        artistsTab = nil
        playlistsTab = nil
        songsTab = nil
        aboutTab = nil
        CPNowPlayingTemplate.shared.remove(self)
        SJAudioEngine.shared.onQueueChanged = nil
        SJAudioEngine.shared.onTrackChanged = nil
        SJAudioEngine.shared.onModeChanged = nil
        SJStreamLibrary.shared.onChange = nil
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
        // The list opens at its top and CarPlay offers no way to scroll it, so
        // it starts at the current song in running order: the song the button
        // named is always the second row. Already-played songs follow below.
        let order = engine.upNextOrder
        let upcoming = Array(order.upcoming.prefix(itemLimit))
        let earlier = Array(order.earlier.prefix(max(0, itemLimit - upcoming.count)))
        let makeItem = { [weak self] (i: Int) -> CPListItem in
            let track = queue[i]
            let item = CPListItem(text: track.title, detailText: track.artist)
            item.setImage(self?.artwork(forTrackId: track.id))
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
        var sections = [CPListSection(items: upcoming.map(makeItem))]
        if !earlier.isEmpty {
            sections.append(CPListSection(items: earlier.map(makeItem), header: "Played", sectionIndexTitle: nil))
        }
        let template = CPListTemplate(title: "Up Next", sections: sections)
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }

    /// How much song text fits on the Up Next button after "UP NEXT: ".
    /// CarPlay draws the button in its own font and never truncates it, so a
    /// longer label grows leftward until it covers the back arrow. Lower this
    /// if a car's screen still collides.
    private let upNextTextLimit = 22

    /// The button itself names the next track, rather than a generic "Up
    /// Next" label that only means something once tapped - so the driver
    /// sees what's coming without opening the queue.
    private func refreshUpNextTitle() {
        guard let next = SJAudioEngine.shared.nextTrack else {
            CPNowPlayingTemplate.shared.upNextTitle = "Up Next"
            return
        }
        let currentArtist = SJAudioEngine.shared.currentTrack?.artist.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let nextArtist = next.artist.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = next.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let withArtist = "\(nextArtist) - \(title)"
        // The artist only earns its room when it changes and still leaves the
        // whole title readable; otherwise the title alone gets the space.
        let description = !nextArtist.isEmpty
            && nextArtist.caseInsensitiveCompare(currentArtist) != .orderedSame
            && withArtist.count <= upNextTextLimit
            ? withArtist : title
        let truncated = ellipsized(description, limit: upNextTextLimit)
        CPNowPlayingTemplate.shared.upNextTitle = "UP NEXT: " + truncated
    }

    /// Cuts at the last word break that fits, so the label ends "Sweet Home…"
    /// rather than "Sweet Home Ala…", unless that would throw away most of it.
    private func ellipsized(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        var cut = String(text.prefix(limit - 1))
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) >= limit / 2 {
            cut = String(cut[..<space])
        }
        while let last = cut.last, " -,:".contains(last) { cut.removeLast() }
        return cut + "…"
    }

    // MARK: - Templates

    private func makeTabBar() -> CPTemplate {
        let artists = CPListTemplate(title: "Artists", sections: withAccount(artistSections()))
        artists.tabTitle = "Artists"
        artists.tabImage = UIImage(systemName: "music.mic")

        let playlists = CPListTemplate(title: "Playlists", sections: withAccount(playlistSections()))
        playlists.tabTitle = "Playlists"
        playlists.tabImage = UIImage(systemName: "music.note.list")

        let songs = CPListTemplate(title: "Songs", sections: withAccount(songSections()))
        songs.tabTitle = "Songs"
        songs.tabImage = UIImage(systemName: "music.note")

        artistsTab = artists
        playlistsTab = playlists
        let about = CPListTemplate(title: "About", sections: aboutSections())
        about.tabTitle = "About"
        about.tabImage = UIImage(systemName: "info.circle")

        songsTab = songs
        aboutTab = about

        return CPTabBarTemplate(templates: [artists, playlists, songs, about])
    }

    private func refreshTabs() {
        artworkCache.removeAll()
        artistsTab?.updateSections(withAccount(artistSections()))
        playlistsTab?.updateSections(withAccount(playlistSections()))
        songsTab?.updateSections(withAccount(songSections()))
        aboutTab?.updateSections(aboutSections())
    }

    // MARK: - Account

    /// Signing in has to happen on the phone: CarPlay gives an app no way to
    /// type a password or show a web sign-in sheet, and Apple does not allow it
    /// while driving. Signed out, each tab opens with a row saying so. Signed
    /// in, the tabs are left alone - who is signed in lives on the About tab
    /// (a section header naming the account floated over the list on scroll).
    private func withAccount(_ sections: [CPListSection]) -> [CPListSection] {
        guard !SJStreamLibrary.shared.isSignedIn else { return sections }
        let prompt = CPListItem(text: "Sign In On Your Phone",
                                detailText: "to unlock your personal content")
        prompt.setImage(UIImage(systemName: "person.crop.circle"))
        prompt.handler = { [weak self] _, completion in
            self?.showSignInHelp()
            completion()
        }
        // The prompt takes one of the template's limited rows, so the list
        // gives one back rather than tripping CarPlay's hard limit.
        var rest = sections
        if let last = rest.last,
           rest.reduce(0, { $0 + $1.items.count }) + 1 > itemLimit, !last.items.isEmpty {
            rest[rest.count - 1] = CPListSection(items: Array(last.items.dropLast()),
                                                 header: last.header,
                                                 sectionIndexTitle: last.sectionIndexTitle)
        }
        return [CPListSection(items: [prompt])] + rest
    }

    private func showSignInHelp() {
        let alert = CPAlertTemplate(
            titleVariants: ["Open Listening Party on your iPhone and sign in. Your uploads will appear here.",
                            "Sign in on your iPhone to see your uploads."],
            actions: [CPAlertAction(title: "OK", style: .cancel) { [weak self] _ in
                self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
            }]
        )
        interfaceController?.presentTemplate(alert, animated: true, completion: nil)
    }

    private func emptySection(_ text: String, _ detail: String) -> [CPListSection] {
        let item = CPListItem(text: text, detailText: detail)
        item.isEnabled = false
        return [CPListSection(items: [item])]
    }

    private static let nothingDownloaded = (
        "Nothing to play yet",
        "Upload music or download songs on listeningparty.stream."
    )

    // MARK: - Artists

    /// One row per artist, opening that artist's songs - rather than every song
    /// under a header, which is what the single list used to be. A locker of any
    /// size is unreadable in a car if the first screen is 400 titles.
    ///
    /// More artists than one driving screen holds become letter ranges
    /// ("A – C", "Ma – Mi") that each open a screen of artists, so every
    /// artist is reachable while moving without scrolling.
    private func artistSections() -> [CPListSection] {
        let downloads = SJCarLibrary.all()
        guard !downloads.isEmpty else {
            return emptySection(Self.nothingDownloaded.0, Self.nothingDownloaded.1)
        }
        let byArtist = Dictionary(grouping: downloads) { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }
        let names = byArtist.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        // Shuffle All takes a row.
        let items = indexItems(names, capacity: tabRows - 1, noun: "artist", key: { $0 }) { [weak self] artist in
            let entries = self?.sorted(byArtist[artist] ?? []) ?? []
            let item = CPListItem(text: artist, detailText: self?.songCount(entries.count))
            item.setImage(entries.lazy.compactMap { self?.artwork(for: $0) }.first)
            item.handler = { [weak self] _, completion in
                self?.pushSongList(title: artist, entries: entries)
                completion()
            }
            return item
        }
        return [CPListSection(items: [shuffleItem(for: downloads)] + items)]
    }

    // MARK: - Lists that fit while driving

    /// While the car is moving, CarPlay shows only the first dozen rows of a
    /// list and will not scroll past them, whatever maximumItemCount says when
    /// parked. Lists that must reach everything are split to fit that.
    private let drivingRows = 12
    private var drivingLimit: Int { max(3, min(itemLimit, drivingRows)) }

    /// Rows a tab has left for its content once the sign-in prompt, when
    /// shown, has taken one.
    private var tabRows: Int { drivingLimit - (SJStreamLibrary.shared.isSignedIn ? 0 : 1) }

    /// Sorted `items` as rows when they fit in `capacity`; otherwise as
    /// alphabetical range rows ("A – C", "Ma – Mi"), each opening the items it
    /// covers - split again the same way if a range is still too long for one
    /// screen. `key` is what the list is sorted by.
    private func indexItems<T>(_ items: [T],
                               capacity: Int,
                               noun: String,
                               key: @escaping (T) -> String,
                               leaf: @escaping (T) -> CPListItem) -> [CPListItem] {
        guard items.count > capacity else { return items.map(leaf) }
        let groups = indexGroups(items, capacity: capacity, key: key)
        return groups.indices.map { i in
            let group = groups[i]
            let label = rangeLabel(first: key(group[0]), last: key(group[group.count - 1]),
                                   before: i > 0 ? groups[i - 1].last.map(key) : nil,
                                   after: i + 1 < groups.count ? groups[i + 1].first.map(key) : nil)
            return rangeRow(label, detail: count(group.count, noun)) { [weak self] in
                guard let self else { return [] }
                return self.indexItems(group, capacity: self.drivingLimit, noun: noun, key: key, leaf: leaf)
            }
        }
    }

    /// For lists whose order means something (a playlist, plays, an album
    /// run): as many items as fit go straight on the screen, the rest behind
    /// numbered rows ("Songs 10 – 21"), each opening one screen of them. `first`
    /// is the 1-based position of `items[0]` in the whole list.
    private func pagedItems<T>(_ items: [T],
                               capacity: Int,
                               title: String,
                               first: Int = 1,
                               describe: @escaping (T) -> String,
                               leaf: @escaping (T) -> CPListItem) -> [CPListItem] {
        guard items.count > capacity else { return items.map(leaf) }
        let page = drivingLimit
        for direct in stride(from: capacity - 1, through: 0, by: -1) {
            let ranges = (items.count - direct + page - 1) / page
            if direct + ranges <= capacity {
                return items.prefix(direct).map(leaf)
                    + numberedRows(items, from: direct, size: page, title: title, first: first,
                                   describe: describe, leaf: leaf)
            }
        }
        // Too many for one level: equal ranges, each split again when opened.
        let size = (items.count + capacity - 1) / capacity
        return numberedRows(items, from: 0, size: size, title: title, first: first, describe: describe, leaf: leaf)
    }

    private func numberedRows<T>(_ items: [T],
                                 from offset: Int,
                                 size: Int,
                                 title: String,
                                 first: Int,
                                 describe: @escaping (T) -> String,
                                 leaf: @escaping (T) -> CPListItem) -> [CPListItem] {
        stride(from: offset, to: items.count, by: size).map { lower in
            let slice = Array(items[lower..<min(lower + size, items.count)])
            let from = first + lower
            let to = from + slice.count - 1
            let label = from == to ? "\(title) \(from)" : "\(title) \(from) – \(to)"
            let ends = [slice.first, slice.count > 1 ? slice.last : nil].compactMap { $0.map(describe) }
            return rangeRow(label, detail: ends.joined(separator: " … ")) { [weak self] in
                guard let self else { return [] }
                return self.pagedItems(slice, capacity: self.drivingLimit, title: title, first: from,
                                       describe: describe, leaf: leaf)
            }
        }
    }

    /// A row that opens a screen of `rows`, built only when tapped.
    private func rangeRow(_ label: String, detail: String, rows: @escaping () -> [CPListItem]) -> CPListItem {
        let item = CPListItem(text: label, detailText: detail)
        item.accessoryType = .disclosureIndicator
        item.handler = { [weak self] _, completion in
            let template = CPListTemplate(title: label, sections: [CPListSection(items: rows())])
            self?.interfaceController?.pushTemplate(template, animated: true, completion: nil)
            completion()
        }
        return item
    }

    private func count(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }

    /// At most `capacity` consecutive runs of items. Items sharing a first
    /// letter stay together when they can, so most rows read as plain letter
    /// ranges; a letter with too many items for one screen is cut into pieces.
    private func indexGroups<T>(_ items: [T], capacity: Int, key: (T) -> String) -> [[T]] {
        var runs: [[T]] = []
        var runInitial: String?
        for item in items {
            let initial = indexInitial(key(item))
            if initial == runInitial, !runs.isEmpty {
                runs[runs.count - 1].append(item)
            } else {
                runs.append([item])
                runInitial = initial
            }
        }
        var target = max(drivingLimit, (items.count + capacity - 1) / capacity)
        while target < items.count {
            var groups: [[T]] = []
            var current: [T] = []
            for run in runs {
                var rest = run[...]
                if !current.isEmpty, current.count + rest.count > target {
                    groups.append(current)
                    current = []
                }
                while rest.count > target {
                    groups.append(Array(rest.prefix(target)))
                    rest = rest.dropFirst(target)
                }
                current += rest
            }
            if !current.isEmpty { groups.append(current) }
            if groups.count <= capacity { return groups }
            target += 1
        }
        // Never one row holding everything: fall back to even slices.
        let size = (items.count + capacity - 1) / capacity
        return stride(from: 0, to: items.count, by: size).map { Array(items[$0..<min($0 + size, items.count)]) }
    }

    /// "A – C" when a range ends on letter boundaries, "Ma – Mi" when it splits
    /// a letter: each end gets just enough letters to differ from the
    /// neighbouring range.
    private func rangeLabel(first: String, last: String, before: String?, after: String?) -> String {
        // When a letter is split across ranges, both ends also differ from
        // each other, so the range reads "Sa – St" rather than "S – St".
        let splitsLetter = before.map(indexInitial) == indexInitial(first)
            || after.map(indexInitial) == indexInitial(last)
        let shared = zip(indexKey(first), indexKey(last)).prefix { $0 == $1 }.count
        let minimum = splitsLetter ? shared + 1 : 1
        let start = distinguishingPrefix(first, from: before, atLeast: minimum)
        let end = distinguishingPrefix(last, from: after, atLeast: minimum)
        return start == end ? start : "\(start) – \(end)"
    }

    private func distinguishingPrefix(_ name: String, from neighbour: String?, atLeast minimum: Int) -> String {
        guard indexInitial(name) != "#" else { return "#" }
        let key = indexKey(name)
        let other = neighbour.map(indexKey) ?? ""
        var length = min(max(1, minimum), max(1, key.count))
        while length < key.count, key.prefix(length) == other.prefix(length) { length += 1 }
        let prefix = key.prefix(length)
        return prefix.prefix(1) + prefix.dropFirst().lowercased()
    }

    private func indexKey(_ name: String) -> String {
        name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).uppercased()
    }

    /// The letter a name files under; digits and symbols share "#".
    private func indexInitial(_ name: String) -> String {
        guard let c = indexKey(name).first, c.isLetter else { return "#" }
        return String(c)
    }

    // MARK: - Playlists

    private func playlistSections() -> [CPListSection] {
        let playable = SJPlaylistStore.shared.playable()
        guard !playable.isEmpty else {
            return emptySection(
                "No playlists on this iPhone",
                SJCarLibrary.all().isEmpty
                    ? Self.nothingDownloaded.1
                    : "Add songs you uploaded or downloaded to a playlist and it will appear here."
            )
        }
        var seen = Set<String>()
        let everySong = playable.flatMap { $0.entries }.filter { seen.insert($0.trackId).inserted }
        let items = pagedItems(playable, capacity: tabRows - 1, title: "Playlists",
                               describe: { $0.playlist.name }) { [weak self] entry -> CPListItem in
            let (playlist, entries) = entry
            // Kept in the saved running order, not re-sorted: a playlist is a
            // sequence, and alphabetising it would quietly destroy the point.
            let item = CPListItem(text: playlist.name, detailText: self?.songCount(entries.count))
            item.setImage(entries.lazy.compactMap { self?.artwork(for: $0) }.first)
            item.handler = { [weak self] _, completion in
                self?.pushSongList(title: playlist.name, entries: entries, preserveOrder: true)
                completion()
            }
            return item
        }
        return [CPListSection(items: [shuffleItem(for: everySong)] + items)]
    }

    // MARK: - About

    /// Version, account, and a My Music entry that can be drilled into to
    /// remove artists, albums, or individual songs from CarPlay only.
    private func aboutSections() -> [CPListSection] {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let app = CPListSection(items: [
            infoItem("Version", "\(version) (\(build))"),
            infoItem("Released", Self.releaseDate()),
        ], header: "Listening Party", sectionIndexTitle: nil)

        let library = SJStreamLibrary.shared
        let account: CPListItem
        if library.isSignedIn {
            account = infoItem(library.accountName ?? "Signed in", library.keyEmail ?? "Signed in")
            account.setImage(UIImage(systemName: "person.crop.circle.fill"))
        } else {
            account = CPListItem(text: "Not signed in", detailText: "Sign in on your iPhone to unlock your personal content")
            account.setImage(UIImage(systemName: "person.crop.circle"))
            account.handler = { [weak self] _, completion in
                self?.showSignInHelp()
                completion()
            }
        }
        let accountSection = CPListSection(items: [account], header: "Account", sectionIndexTitle: nil)

        // A song is public when the server lists it as artist-licensed; every
        // other song the car has - own uploads, own downloads - is personal.
        let songs = SJCarLibrary.all()
        let isPublic: (SJCarEntry) -> Bool = { SJStreamLibrary.shared.entry(for: $0.trackId)?.source == "artist" }
        let publicSongs = songs.filter(isPublic)
        let playlists = SJPlaylistStore.shared.playable().map { $0.playlist }
        let publicPlaylists = playlists.filter { $0.mine == false }.count

        let myMusic = CPListItem(text: "My Music", detailText: musicSummary(songs))
        myMusic.setImage(UIImage(systemName: "music.note.house"))
        myMusic.handler = { [weak self] _, completion in
            self?.showMyMusic()
            completion()
        }

        return [app, accountSection,
                CPListSection(items: [myMusic], header: "Your Library", sectionIndexTitle: nil),
                countsSection("Public Library", publicSongs, playlists: publicPlaylists)]
    }

    private func musicSummary(_ songs: [SJCarEntry]) -> String {
        let artists = Set(songs.map { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }).count
        let albums = Set(songs.map { ($0.artist.isEmpty ? "Unknown Artist" : $0.artist) + "\u{0}" + ($0.album ?? "Unknown Album") }).count
        return "\(artists) artist\(artists == 1 ? "" : "s") · \(albums) album\(albums == 1 ? "" : "s") · \(songCount(songs.count))"
    }

    private func showMyMusic() {
        let songs = SJCarLibrary.all()
        let artists = Set(songs.map { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }).count
        let albums = Set(songs.map { ($0.artist.isEmpty ? "Unknown Artist" : $0.artist) + "\u{0}" + ($0.album ?? "Unknown Album") }).count
        var items: [CPListItem] = []
        let artistItem = CPListItem(text: "Artists", detailText: artists.formatted())
        artistItem.setImage(UIImage(systemName: "music.mic"))
        artistItem.handler = { [weak self] _, completion in self?.showArtistRemovals(); completion() }
        items.append(artistItem)
        let albumItem = CPListItem(text: "Albums", detailText: albums.formatted())
        albumItem.setImage(UIImage(systemName: "square.stack"))
        albumItem.handler = { [weak self] _, completion in self?.showAlbumRemovals(); completion() }
        items.append(albumItem)
        let songItem = CPListItem(text: "Songs", detailText: songs.count.formatted())
        songItem.setImage(UIImage(systemName: "music.note"))
        songItem.handler = { [weak self] _, completion in self?.showSongRemovals(); completion() }
        items.append(songItem)

        let removed = SJCarPlayExclusions.shared.trackIds
            .filter { SJCarLibrary.entryIncludingExcluded(for: $0) != nil }.count
        if removed > 0 {
            let restore = CPListItem(text: "Restore Removed Music", detailText: songCount(removed))
            restore.setImage(UIImage(systemName: "arrow.uturn.backward"))
            restore.handler = { [weak self] _, completion in
                self?.confirmRestoreAll()
                completion()
            }
            items.append(restore)
        }
        interfaceController?.pushTemplate(CPListTemplate(title: "My Music", sections: [CPListSection(items: items)]),
                                          animated: true, completion: nil)
    }

    private func showArtistRemovals() {
        let groups = Dictionary(grouping: SJCarLibrary.all()) { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }
        let names = groups.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        let items = indexItems(names, capacity: drivingLimit, noun: "artist", key: { $0 }) { [weak self] name in
            self?.removalItem(name, detail: self?.songCount(groups[name]?.count ?? 0),
                              trackIds: Set((groups[name] ?? []).map(\.trackId))) ?? CPListItem(text: name, detailText: nil)
        }
        pushRemovalList(title: "Remove Artists", items: items)
    }

    private func showAlbumRemovals() {
        let groups = Dictionary(grouping: SJCarLibrary.all()) {
            ($0.artist.isEmpty ? "Unknown Artist" : $0.artist) + "\u{0}" + ($0.album ?? "Unknown Album")
        }
        let album: (String) -> String = { key in
            let parts = key.split(separator: "\u{0}", maxSplits: 1, omittingEmptySubsequences: false)
            return parts.count > 1 ? String(parts[1]) : "Unknown Album"
        }
        let keys = groups.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        let items = pagedItems(keys, capacity: drivingLimit, title: "Albums", describe: album) { [weak self] key -> CPListItem in
            let artist = String(key.split(separator: "\u{0}", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
            let detail = artist + " · " + (self?.songCount(groups[key]?.count ?? 0) ?? "")
            return self?.removalItem(album(key), detail: detail, trackIds: Set((groups[key] ?? []).map(\.trackId)))
                ?? CPListItem(text: album(key), detailText: nil)
        }
        pushRemovalList(title: "Remove Albums", items: items)
    }

    private func showSongRemovals() {
        let songs = SJCarLibrary.all().sorted {
            let title = $0.title.localizedStandardCompare($1.title)
            return title == .orderedSame ? $0.trackId < $1.trackId : title == .orderedAscending
        }
        let items = indexItems(songs, capacity: drivingLimit, noun: "song", key: { $0.title }) { [weak self] song in
            self?.removalItem(song.title, detail: song.artist, trackIds: [song.trackId])
                ?? CPListItem(text: song.title, detailText: nil)
        }
        pushRemovalList(title: "Remove Songs", items: items)
    }

    private func pushRemovalList(title: String, items: [CPListItem]) {
        let section = items.isEmpty
            ? CPListSection(items: [disabledItem("Nothing to remove", "Your CarPlay music library is empty.")])
            : CPListSection(items: items)
        interfaceController?.pushTemplate(CPListTemplate(title: title, sections: [section]), animated: true, completion: nil)
    }

    private func removalItem(_ text: String, detail: String?, trackIds: Set<String>) -> CPListItem {
        let item = CPListItem(text: text, detailText: detail)
        item.handler = { [weak self] _, completion in
            self?.confirmRemoval(name: text, trackIds: trackIds)
            completion()
        }
        return item
    }

    private func confirmRemoval(name: String, trackIds: Set<String>) {
        let alert = CPAlertTemplate(titleVariants: ["Remove \(name) from CarPlay?", "Remove from CarPlay?"], actions: [
            CPAlertAction(title: "Remove", style: .destructive) { [weak self] _ in
                SJCarPlayExclusions.shared.exclude(trackIds)
                self?.removeFromCurrentQueueAndAdvance(trackIds: trackIds)
                self?.refreshTabs()
                self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
                self?.interfaceController?.popToRootTemplate(animated: true, completion: nil)
            },
            CPAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
                self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
            },
        ])
        interfaceController?.presentTemplate(alert, animated: true, completion: nil)
    }

    private func confirmRestoreAll() {
        let alert = CPAlertTemplate(titleVariants: ["Restore all music removed from CarPlay?", "Restore removed music?"], actions: [
            CPAlertAction(title: "Restore All", style: .default) { [weak self] _ in
                SJCarPlayExclusions.shared.restoreAll()
                self?.refreshTabs()
                self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
                self?.interfaceController?.popToRootTemplate(animated: true, completion: nil)
            },
            CPAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
                self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
            },
        ])
        interfaceController?.presentTemplate(alert, animated: true, completion: nil)
    }

    private func countsSection(_ title: String, _ songs: [SJCarEntry], playlists: Int) -> CPListSection {
        let artists = Set(songs.map { $0.artist.isEmpty ? "Unknown Artist" : $0.artist }).count
        return CPListSection(items: [
            infoItem("Artists", artists.formatted()),
            infoItem("Songs", songs.count.formatted()),
            infoItem("Playlists", playlists.formatted()),
        ], header: title, sectionIndexTitle: nil)
    }

    private func infoItem(_ text: String, _ detail: String) -> CPListItem {
        CPListItem(text: text, detailText: detail)
    }

    /// When this build was made: the app binary's own timestamp, so it is
    /// right for every build without anyone remembering to update it.
    private static func releaseDate() -> String {
        guard let url = Bundle.main.executableURL,
              let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        else { return "Unknown" }
        return date.formatted(date: .abbreviated, time: .omitted)
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
                if let self { self.songsTab?.updateSections(self.withAccount(self.songSections())) }
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
        let downloads = SJCarLibrary.all().sorted { a, b in
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
        let actions = queueActionItems(for: downloads)
        let capacity = tabRows - actions.count - 1
        let leaf: (SJCarEntry) -> CPListItem = { [weak self] entry in
            self?.listItem(entry, in: downloads, showArtist: true) ?? CPListItem(text: entry.title, detailText: nil)
        }
        // Alphabetical splits by letter; the other sorts keep their order and
        // split by position, naming the songs at each end.
        let byArtist = songSort == "By Artist"
        let songs = songSort == "Alphabetical"
            ? indexItems(downloads, capacity: capacity, noun: "song", key: { $0.title }, leaf: leaf)
            : pagedItems(downloads, capacity: capacity, title: "Songs",
                         describe: { byArtist ? $0.artist : $0.title }, leaf: leaf)
        return [CPListSection(items: actions + [sort] + songs)]
    }

    // MARK: - Shared list plumbing

    private func pushSongList(title: String,
                              entries: [SJCarEntry],
                              preserveOrder: Bool = false) {
        let ordered = preserveOrder ? entries : sorted(entries)
        let actions = queueActionItems(for: ordered)
        let songs = pagedItems(ordered, capacity: drivingLimit - actions.count, title: "Songs",
                               describe: { $0.title }) { [weak self] entry in
            self?.listItem(entry, in: ordered, showArtist: false) ?? CPListItem(text: entry.title, detailText: nil)
        }
        let section = CPListSection(items: actions + songs)
        let template = CPListTemplate(title: title, sections: [section])
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }

    private func shuffleItem(for entries: [SJCarEntry]) -> CPListItem {
        let item = CPListItem(text: "Shuffle All", detailText: songCount(entries.count))
        item.setImage(UIImage(systemName: "shuffle"))
        item.isEnabled = !entries.isEmpty
        item.handler = { [weak self] _, completion in
            // The first song is drawn with the listener's own weights too, not
            // at random - otherwise Shuffle All ignores the preference for
            // exactly the song they are most likely to notice.
            let profile = SJShuffleProfile.shared
            let first: SJCarEntry?
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

    /// The first three rows in every concrete song list are playback actions:
    /// Shuffle All, Play All Next, and Add All to Queue. Artists and playlists
    /// reach this list after their first drill-down; Songs shows the same trio
    /// directly above its sort row.
    private func queueActionItems(for entries: [SJCarEntry]) -> [CPListItem] {
        let playNext = CPListItem(text: "Play All Next", detailText: songCount(entries.count))
        playNext.setImage(UIImage(systemName: "text.insert"))
        playNext.isEnabled = !entries.isEmpty
        playNext.handler = { [weak self] _, completion in
            self?.add(entries, next: true)
            completion()
        }

        let addQueue = CPListItem(text: "Add All to Queue", detailText: songCount(entries.count))
        addQueue.setImage(UIImage(systemName: "text.badge.plus"))
        addQueue.isEnabled = !entries.isEmpty
        addQueue.handler = { [weak self] _, completion in
            self?.add(entries, next: false)
            completion()
        }
        return [shuffleItem(for: entries), playNext, addQueue]
    }

    private func add(_ entries: [SJCarEntry], next: Bool) {
        let additions = tracks(for: entries)
        guard !additions.isEmpty else { return }
        let engine = SJAudioEngine.shared
        guard engine.index >= 0, engine.queue.indices.contains(engine.index) else {
            engine.setQueue(additions, startIndex: 0, autoPlay: true)
            interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
            return
        }
        var queue = engine.queue
        if next {
            queue.insert(contentsOf: additions, at: min(queue.count, engine.index + 1))
        } else {
            queue.append(contentsOf: additions)
        }
        // Re-selecting the same current song makes setQueue preserve its play
        // state and position while exposing the expanded queue to car + phone.
        engine.setQueue(queue, startIndex: engine.index, autoPlay: false)
    }

    private func tracks(for entries: [SJCarEntry]) -> [SJTrack] {
        entries.map { e in
            SJTrack(id: e.trackId,
                    title: e.title,
                    artist: e.artist,
                    album: e.album,
                    artworkURL: nil,
                    url: nil,
                    durationSeconds: e.durationSeconds)
        }
    }

    private func listItem(_ entry: SJCarEntry,
                          in queue: [SJCarEntry],
                          showArtist: Bool) -> CPListItem {
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

    private func sorted(_ entries: [SJCarEntry]) -> [SJCarEntry] {
        entries.sorted { ($0.album ?? "", $0.title) < ($1.album ?? "", $1.title) }
    }

    private func songCount(_ n: Int) -> String { "\(n) song\(n == 1 ? "" : "s")" }

    /// Covers come off disk, already fetched at download time. Decoding on the
    /// main thread is what makes a long list stutter, so results are cached and
    /// the image is scaled down to the row size CarPlay actually draws.
    private var artworkCache: [String: UIImage] = [:]

    private func artwork(for entry: SJCarEntry?) -> UIImage? {
        guard let entry else { return nil }
        if let cached = artworkCache[entry.trackId] { return cached }
        guard let url = SJCarLibrary.artworkFileURL(for: entry.trackId),
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

    /// Up Next works from the live queue (SJTrack), not the library, so it
    /// needs its cover by id rather than by SJCarEntry.
    private func artwork(forTrackId trackId: String) -> UIImage? {
        artwork(for: SJCarLibrary.entry(for: trackId))
    }

    // MARK: - Now Playing actions and reactions

    /// Four buttons on the Now Playing screen, left to right: the "..." list of
    /// actions, a heart that stamps the moment being
    /// listened to (drawn with a count once the track has any), repeat, and
    /// shuffle on the far right. There is no rating button: thumbs are retired.
    ///
    /// A tap goes to disk before anything else (SJFeedbackOutbox). The web layer
    /// does the actual sending, but in a car it may be suspended and is often
    /// offline, so a straight bridge call would drop presses silently.
    private func refreshNowPlayingButtons() {
        guard let trackId = SJAudioEngine.shared.currentTrack?.id else {
            CPNowPlayingTemplate.shared.updateNowPlayingButtons([])
            return
        }
        let engine = SJAudioEngine.shared

        let more = CPNowPlayingMoreButton { [weak self] _ in
            self?.showNowPlayingActions(trackId: trackId)
        }

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

        let shuffle = CPNowPlayingImageButton(
            image: symbol("shuffle", color: engine.shuffleEnabled ? .systemGreen : nil)
        ) { _ in
            SJAudioEngine.shared.setShuffle(!SJAudioEngine.shared.shuffleEnabled)
        }
        shuffle.isSelected = engine.shuffleEnabled

        CPNowPlayingTemplate.shared.updateNowPlayingButtons([more, heart, repeatBtn, shuffle])
    }

    /// The "..." menu, as a pushed list rather than an action sheet. A CarPlay
    /// action sheet holds three buttons and has no close box, so Cancel took a
    /// third of it; a list holds every option picked in Settings, and the
    /// system back arrow in the top corner closes it. The list is deliberately
    /// complete now that it has room; there is no matching Settings screen.
    private func showNowPlayingActions(trackId: String) {
        guard let track = SJAudioEngine.shared.currentTrack, track.id == trackId else { return }
        var feedback: [(String, () -> Void)] = [7, 30, 90, 180].map { days in
            ("Take a Break for \(days) Days", { [weak self] in self?.exclude(trackId: trackId, kind: "snooze", value: days) })
        } + [
            ("Never Play Again", { [weak self] in self?.exclude(trackId: trackId, kind: "block", value: 1) }),
            ("Remove Song from CarPlay", { [weak self] in self?.removeFromCarPlay(trackId: trackId) }),
        ]
        if heartCounts(trackId).today > 0 {
            feedback.append(("Remove My Ratings Today", { [weak self] in self?.removeHearts(trackId: trackId, todayOnly: true) }))
            feedback.append(("Remove All My Ratings for This Song", { [weak self] in self?.removeHearts(trackId: trackId, todayOnly: false) }))
        }
        let items = feedback.map { title, run -> CPListItem in
            let item = CPListItem(text: title, detailText: nil)
            item.handler = { [weak self] _, completion in
                // Back to Now Playing first, so the next song is what the
                // driver sees when the action skips this one.
                self?.interfaceController?.popTemplate(animated: true) { _, _ in run() }
                completion()
            }
            return item
        }
        let list = CPListTemplate(title: track.title, sections: [CPListSection(items: items)])
        interfaceController?.pushTemplate(list, animated: true, completion: nil)
    }

    private func removeFromCarPlay(trackId: String) {
        SJCarPlayExclusions.shared.exclude([trackId])
        removeFromCurrentQueueAndAdvance(trackIds: [trackId])
        refreshTabs()
    }

    private func disabledItem(_ text: String, _ detail: String) -> CPListItem {
        let item = CPListItem(text: text, detailText: detail)
        item.isEnabled = false
        return item
    }

    private func exclude(trackId: String, kind: String, value: Int) {
        SJFeedbackOutbox.shared.add(kind: kind, trackId: trackId, value: value, positionMs: 0)
        removeFromCurrentQueueAndAdvance(trackIds: [trackId])
        SJCarPlayFeedback.shared.onChange?()
    }

    private func removeHearts(trackId: String, todayOnly: Bool) {
        SJFeedbackOutbox.shared.add(kind: todayOnly ? "removeHeartsToday" : "removeAllHearts",
                                    trackId: trackId, value: 0, positionMs: 0)
        refreshNowPlayingButtons()
        SJCarPlayFeedback.shared.onChange?()
    }

    private func removeFromCurrentQueueAndAdvance(trackIds: Set<String>) {
        let engine = SJAudioEngine.shared
        let oldIndex = engine.index
        let remaining = engine.queue.filter { !trackIds.contains($0.id) }
        engine.setQueue(remaining,
                        startIndex: remaining.isEmpty ? 0 : min(max(0, oldIndex), remaining.count - 1),
                        autoPlay: !remaining.isEmpty)
    }

    /// The server's count, plus anything hearted in the car that has not been
    /// sent yet - so a tap bumps the badge immediately.
    private func heartCounts(_ trackId: String) -> (all: Int, today: Int) {
        var all = SJCarPlayFeedback.shared.heartCount(for: trackId)
        var today = SJCarPlayFeedback.shared.heartCountToday(for: trackId)
        let calendar = Calendar.current
        for item in SJFeedbackOutbox.shared.pending().filter({ $0.trackId == trackId }).sorted(by: { $0.at < $1.at }) {
            switch item.kind {
            case "heart":
                all += 1
                if calendar.isDateInToday(Date(timeIntervalSince1970: item.at)) { today += 1 }
            case "removeHeartsToday":
                all = max(0, all - today)
                today = 0
            case "removeAllHearts":
                all = 0
                today = 0
            default: break
            }
        }
        return (max(0, all), max(0, today))
    }

    private func heartCount(_ trackId: String) -> Int {
        heartCounts(trackId).all
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

    private func play(startingAt entry: SJCarEntry,
                      in entries: [SJCarEntry]) {
        let tracks = tracks(for: entries)
        let start = entries.firstIndex { $0.trackId == entry.trackId } ?? 0
        SJAudioEngine.shared.setQueue(tracks, startIndex: start, autoPlay: true)
        interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
    }
}
