# Record Keeper submissions — October 6, 2026

Google Play app: `com.johnnyoutlaw.recordkeeper`, Data Day Studio organization.
Console app ID: `4975529032528259557`.

The signed version 1 / 1.0 bundle was accepted and published to the internal
testing track as **1.0 — Android Auto internal testing**. Google Play displays
“Available to internal testers” and “Not reviewed.” The dedicated Record Keeper
Internal Testers list is enabled with two owner-approved accounts; the track is
Active. Tester email addresses are managed in the console rather than Git.
Join URL: https://play.google.com/apps/internaltest/4700466641862230992.
This is not a production review submission or public launch.

The minimum SDK is now 24 to satisfy Play automatic protection; target SDK is 36.
The corrected signed release build, Android lint and unit tests passed.
The earlier device tests verified Media3 browsing, search and actual native audio
playback without a phone Activity/WebView. Physical car/Desktop Head Unit testing
is still required before claiming the Android Auto experience is verified.

The default en-US store listing draft contains the Record Keeper name, short/full
descriptions, 512px icon and feature graphic. Phone screenshots, category/contact
details, privacy/account-access declarations, rating, audience and data-safety
forms remain to be completed before production review. Google temporarily shows
the package name followed by “unreviewed” for internal downloads.

Apple: the Record Keeper iOS source and Mac build instructions are checked in.
An App Store Connect build/review submission has not been completed from Windows.
The Mac must register/sign the new bundle ID, obtain its CarPlay capability,
test/archive the app and upload it. See `../README.md` for the commands.

Signing keys stay in Bitwarden; only their secret identifiers are checked in.
Generated APK/AAB, CocoaPods and native web assets are excluded from Git and are
reproducible with the checked-in scripts.
