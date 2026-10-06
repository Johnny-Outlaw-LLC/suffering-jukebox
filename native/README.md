# Suffering Jukebox — native shell

> **Why this directory is called `native/` and not `app/`:** Next.js treats a
> root-level `app/` directory as the App Router and ignores `src/app` when one
> exists. Naming this `app/` silently hijacks routing and makes every route on
> the site 404. Do not rename it back.

Capacitor app around the existing web UI, plus a native audio engine.

The split is deliberate:

| Layer   | Owns |
|---------|------|
| WebView | Catalog, rooms, lyrics, ratings, YouTube playback (foreground only) |
| Native  | Real audio files: streaming and offline downloads, background audio, lock screen, CarPlay |

Only **real audio files** reach the native engine: the signed-in user's own
uploads, and songs an artist has licensed (`artist_rights_agreements`).
YouTube-backed tracks have no file to hand the OS, so they never appear in
CarPlay and cannot be downloaded. That is a hard constraint from both CarPlay
and YouTube's terms, not a first cut.

## Streaming in the car (no download needed) - 2026-09-28

CarPlay lists everything in `SJCarLibrary`: downloads, plus the streamable list
from `GET /api/sj-carplay-library` (your uploads + every artist-licensed song).
Uploading an MP3 for background play is therefore enough to hear it in the car.

- **The car key.** The car cannot sign in and the web view is asleep on a drive,
  so the signed-in page asks `POST /api/sj-carplay-key` for a key once per device
  per account (`sjCarEnsureAccess()`), and native keeps it in the Keychain
  (`SJStreamLibrary`). Only its sha256 is stored (`jukebox.carplay_keys`,
  service role only). It reads its owner's locker and nothing else. Sign-out
  revokes it.
- **URLs are resolved as each song starts** (`GET /api/sj-carplay-stream`),
  never handed over in advance: a presigned URL from before the drive would
  have expired. A downloaded file always wins, so offline play is unchanged.
- **Artist-licensed songs need no key**, so they are in the car for everyone,
  signed in or not. They follow the mobile-background rule in
  `approvedArtistAudioTracks()`, the same one `/api/sj-artist-audio` uses.
- The list and covers are cached on disk, and refresh on launch, on return to
  the foreground, when CarPlay connects, and after an upload or removal.
- A queue the car cannot reach (no signal, streamed songs only) stops after one
  pass instead of skipping round forever (`skipUnplayable()`).

## Taking songs offline

Streaming needs signal. For a drive without it, download to the phone. Picking a
drive's worth of music on a phone is miserable, so the picking and the
downloading are split across devices:

1. **Anywhere else** (usually a desktop) — Settings → Audio Storage, `＋ Send to
   iPhone` on a song or `＋ Send all to iPhone` on an artist. That writes track
   ids to `jukebox.carplay_queue` through `/api/sj-carplay-queue`. No audio moves.
2. **On the phone** — the app checks the queue on sign-in and on every return to
   the foreground, and offers the list as one sheet: *Ready for CarPlay*.
   Downloading is a deliberate tap there, never automatic: the phone may be on
   cellular and the list may be a whole discography.
3. A finished download marks its row accepted, which is what turns the desktop's
   `◷ Queued` into `✓ On iPhone`.

The phone can still download a single song directly — the track menu and the
`＋ CarPlay` buttons in Audio Storage are unchanged. Removing a queue row never
deletes a file, and removing a download never deletes a queue row: they are a
request and a file, not two copies of one state.

## Build

### Record Keeper iOS

From `native/`, run `npm run sync:recordkeeper:ios` to generate and sync the
Record Keeper product, or `npm run ios:recordkeeper` to also open it in Xcode.
The workspace is `products/record-keeper/ios/App/App.xcworkspace` and the scheme
is `App`. Its bundle ID is `com.johnnyoutlaw.recordkeeper`, version 1.0.0,
build 1. Listening Party retains its existing bundle ID and workspace.

Both products bundle the canonical `public/` interface and use brand settings
from `src/lib/surface.ts`. Record Keeper inherits the same native streaming,
offline downloads, lock-screen controls, playlists, background audio, and
CarPlay sources. Spotify playback follows Record Keeper's disabled web feature.

`products/` is generated and ignored. Make native source changes in `native/ios`
and web changes in `public/`, then sync again. Do not make durable changes in
the generated project; each sync recopies the maintained project and sources.
This iOS-only command does not generate or sync Android.

Before device distribution, register the explicit Record Keeper App ID on team
2J69KHU242 with Sign in with Apple and the managed CarPlay audio capability,
and obtain a matching provisioning profile. Confirm its native sign-in callback
`com.johnnyoutlaw.recordkeeper://auth` is accepted by the shared authentication
service and its bundle ID is an accepted native Apple sign-in audience. The
existing Listening Party entitlement/profile does not establish those settings
for a new bundle ID. Deploy the `app.recordkeeper.stream` CORS and `/yt-frame`
frame-ancestor changes before testing the complete online flow.

Build without device signing for simulator verification:

```bash
cd products/record-keeper/ios/App
xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /private/tmp/record-keeper-ios-build CODE_SIGNING_ALLOWED=NO build
```

```bash
npm install
npm run sync     # stage web assets into www/ and run cap sync
npm run ios      # open Xcode
```

CocoaPods needs a UTF-8 locale or it fails on the space in the repo path; the
npm scripts set it. `npm run pods` reinstalls pods on their own.

## Xcode project is generated

`cap add ios` regenerates `ios/` from a template, which would drop the native
sources and build settings. `scripts/xcode-wire.mjs` re-applies them and is
idempotent — run it after any regeneration:

```bash
node scripts/xcode-wire.mjs
```

It adds the Swift sources, sets `CODE_SIGN_ENTITLEMENTS`, and pins the
deployment target to iOS 15 (CarPlay's `CPListItem.isEnabled` needs it).

## Scene lifecycle

CarPlay requires a scene manifest with `UIApplicationSupportsMultipleScenes`.
Declaring any scene configuration opts the whole app into the scene lifecycle,
at which point `UIMainStoryboardFile` is ignored and nothing builds the phone
window — the app launches to a black screen. So:

- `UIMainStoryboardFile` is removed from `Info.plist`.
- `SJSceneDelegate` builds the window and installs `SJBridgeViewController`.
- `SJCarPlaySceneDelegate` handles the car scene.

Both are referenced by bare ObjC class name via `@objc(...)`.

`SJBridgeViewController` exists because Capacitor only auto-registers plugins
that ship as npm packages; `SJNativeAudio` lives in the app target and must be
handed to the bridge in `capacitorDidLoad()`.

## Installing on a device

Automatic signing on team 2J69KHU242 (the same team as the other Johnny Outlaw
LLC apps; D89QH2NM22 is the Personal Team and cannot reach the App Store).

```bash
npm run sync
cd ios/App
xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build
xcrun devicectl device install app --device <device-id> \
  ~/Library/Developer/Xcode/DerivedData/App-<hash>/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <device-id> --terminate-existing \
  com.johnnyoutlaw.sufferingjukebox
```

The DerivedData path glob (`App-*`) matches every derived-data folder Xcode has
ever made for this project, not just the latest - `install` fails with
"Unexpected argument" if more than one exists, so resolve the `<hash>` first
(`ls -dt ~/Library/Developer/Xcode/DerivedData/App-*/ | head -1`) rather than
passing the wildcard straight through. `device launch` is also gone as of the
Xcode 17 toolchain; the subcommand is `device process launch`.

`xcrun devicectl list devices` prints the device ids. The phone has to be
unlocked and trusted or it shows as `unavailable`.

## CarPlay entitlement

`App.entitlements` declares `com.apple.developer.carplay-audio`. Apple must
approve this before it works on a device or in TestFlight — request it at
<https://developer.apple.com/contact/carplay/>. Simulator builds do not
validate entitlements, so CarPlay can be developed while that is pending.
