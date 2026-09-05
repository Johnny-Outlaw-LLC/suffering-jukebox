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
| Native  | Locker files: offline downloads, background audio, lock screen, CarPlay |

Only **locker tracks** — a file the signed-in user uploaded to `jukebox-audio` —
reach the native engine. YouTube-backed tracks have no file to hand the OS, so
they never appear in CarPlay and cannot be downloaded. That is a hard
constraint from both CarPlay and YouTube's terms, not a first cut.

## Getting songs into the car

CarPlay can only play files that are already on the phone, and picking a drive's
worth of music on a phone is miserable. So the picking and the downloading are
split across devices:

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
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device launch app --device <device-id> com.johnnyoutlaw.sufferingjukebox
```

`xcrun devicectl list devices` prints the device ids. The phone has to be
unlocked and trusted or it shows as `unavailable`.

## CarPlay entitlement

`App.entitlements` declares `com.apple.developer.carplay-audio`. Apple must
approve this before it works on a device or in TestFlight — request it at
<https://developer.apple.com/contact/carplay/>. Simulator builds do not
validate entitlements, so CarPlay can be developed while that is pending.
