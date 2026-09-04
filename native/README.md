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

## CarPlay entitlement

`App.entitlements` declares `com.apple.developer.carplay-audio`. Apple must
approve this before it works on a device or in TestFlight — request it at
<https://developer.apple.com/contact/carplay/>. Simulator builds do not
validate entitlements, so CarPlay can be developed while that is pending.
