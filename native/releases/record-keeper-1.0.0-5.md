# Record Keeper 1.0.0 (5)

- App Store Connect app: 6819821388
- Bundle ID: com.johnnyoutlaw.recordkeeper
- Web source commit: 7948823 (includes c86d3df)
- Build 5 uploaded successfully at 5:51 PM Central, before the user requested heart first in the dock. Superseded by build 6.
- Build 3 remains in Apple review, as requested.

Added a playback heart immediately after pause in the compact mobile dock.
Both dock heart controls synchronize to the playing track and the same shared
reaction total. Restored the count badge on the expanded mobile player; its
stylesheet previously hid the badge. The dock's runtime control arrangement
includes the new heart, and long-press undo uses the existing reaction flow.

Validation: 505 checks in 53 reported suites passed. Regression tests confirm
two successful native heart saves update the expanded and docked counts from
1 to 2, rejected saves roll back, and the runtime arrangement preserves
pause / heart / next. Production Record Keeper contains both UI fixes and the
correct runtime order. Browser automation stalled during playback, so visual
phone interaction and actual phone heart taps were not independently verified.

Generated with `npm run sync:recordkeeper:ios`, then archived with
`MARKETING_VERSION=1.0.0 CURRENT_PROJECT_VERSION=5`. Signed identity/version and
bundled UI verified. Bundled index SHA-256:
`b4cf472e23ec6f5742f1a6cfb5879771b3f9cbd17bcb643575780e3ca789ef9a`.

Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-06/Record Keeper 1.0.0 (5).xcarchive`.
Archive log: `/private/tmp/rk-release-archive-5-final.log`.
Upload log: `/private/tmp/rk-release-upload-5-final.log`.

The first build-5 upload was stopped during package analysis to include the
runtime arrangement correction. Only the final archive above is the release.
