# Record Keeper native apps

Both new products use `com.johnnyoutlaw.recordkeeper`. The Listening Party project
remains `native/ios`; its bundle ID and signing identity are preserved.
Record Keeper's separate iOS project is checked in under `native/recordkeeper/ios`.
Android source, Gradle wrapper, icons, listing text and release scripts are also
checked in. Generated web bundles, builds, CocoaPods, local SDK paths and keys
are excluded; the commands below recreate them on either computer.

## Mac handoff

```sh
git pull --ff-only origin main
npm ci
npm ci --prefix native
cd native
npm run recordkeeper:ios
cd recordkeeper
npx cap open ios
```

Open the Record Keeper workspace, select the organization team `2J69KHU242`, and
register the explicit Record Keeper App ID. Enable Sign in with Apple and request
or enable CarPlay Audio for that ID. Listening Party's approved entitlement does
not automatically approve the new ID. Add the Record Keeper bundle ID to the
shared Supabase Apple provider's native client IDs after Apple registration.
Archive, test on an iPhone and CarPlay, then upload via Xcode Organizer/TestFlight.
The checked-in Swift app has the existing audio, downloads, ratings and CarPlay
implementation with Record Keeper's domain, callback scheme and icon.

`prepare-recordkeeper-ios.mjs` only seeds a missing project. It preserves an
existing project and any Mac edits. Commit Mac source changes to this repository.

## Android

Requires JDK 21 and Android SDK 36. Set `JAVA_HOME` and `ANDROID_HOME`, or use
Android Studio's configured SDK. `local.properties` is generated locally.

```sh
npm ci
npm ci --prefix native
npm run recordkeeper:android --prefix native
cd native/recordkeeper/android
chmod +x gradlew
./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
./gradlew :app:connectedDebugAndroidTest
```

The instrumentation tests need an emulator or connected Android phone with
internet access. They browse/search the authorized library and play real audio
with no phone Activity/WebView. Android Auto and the phone share one Media3
MediaLibraryService, ExoPlayer, queue and notification. It supports voice search,
transport controls, shuffle/repeat, background audio, late stream resolution,
Keystore-protected car access, and on-device downloads. Car browsing filters
playlists to playable audio. YouTube-only media never reaches the native engine.

GitHub Actions builds a debug APK and runs lint when native/shared assets change.
The debug APK is for development, not the store. Release builds require the
Record Keeper upload key held in Bitwarden; another app's signing key is not used.
`signing-secret-ids.json` has only secret identifiers, so the Mac can find the same
key in the vault. Inject its four named variables and run:

```sh
python native/recordkeeper/store/build-release.py
```

On this Windows workspace, the Bitwarden launcher profile is
`Projects/Suffering Jukebox/suffering-jukebox-fresh/native/recordkeeper/signing.env.local`.
The script materializes an encrypted keystore only in a restricted temporary
folder, removes it afterward, and fails if release signing credentials are missing.
AAB: `android/app/build/outputs/bundle/release/app-release.aab`.
APK: `android/app/build/outputs/apk/release/app-release.apk`.

## Store submissions

Listing text, reviewer notes, icons, splash and Google Play feature artwork are
in `store/`. Create new listings named **Record Keeper**; do not rename the existing
Listening Party listing. Upload the signed AAB to Google Play internal testing
first, enable the Android Auto form factor, and run the Android Auto desktop-head
unit and real-car checks before production review. The developer account currently
accessible in Chrome is Data Day Studio (account 9009368346982319606).

Submit App Store Connect only after the Mac's archive, entitlement and device tests.
Neither store approval nor physical-car testing is implied by a successful build.

Use `store/listing.json` as the starting text. Complete age rating and content rights
from the actual music and user-generated-content experience. For privacy forms,
review the live policy and implementation: account name/email and identifier,
user-uploaded files, playlists/listening history, interactions, IP-derived location
and diagnostics can be processed. No GPS, microphone or contacts permissions are
requested. Do not mark "no data collected". Foreground YouTube may serve its own
ads; disclose that accurately in the Google Play Contains Ads answer.

Account deletion already exists in Settings > Account and `/api/sj-account`.
Google Play’s public account/data-deletion request URL is
https://recordkeeper.stream/delete-account. It explains the existing in-app
deletion flow, the shared music account scope and how to request deletion
through support without reinstalling the app. Reviewers needing private uploads
should receive the existing test-account credentials in the console, never Git.

Google's final Create App/submission declarations must be accepted by the account
owner. This repository prepares the binaries and metadata; it does not attest to
untested device behavior or claim that an app has passed store review.
