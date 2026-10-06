# Record Keeper 1.0.0 (4)

- App Store Connect app: 6819821388
- Bundle ID: com.johnnyoutlaw.recordkeeper
- Web source commit: e1f8d90
- Uploaded October 6, 2026 at 5:32 PM America/Chicago.
- Xcode confirmed `Upload succeeded` and `EXPORT SUCCEEDED`.
- Apple processing is pending.
- Development export installed and launched successfully on Magic.
- Build 3 remains in the App Store review queue; build 4 has not replaced it.

Play All appears above Shuffle All in Explore artist and playlist menus and in
the Explore page controls. Single-song lists retain Play All and omit Shuffle
All. Ordered play explicitly disables shuffle and follows album/track order or
playlist position. Native heart creation and removal use the existing
CapacitorHttp API transport rather than WKWebView fetch.

Validation: all 503 checks in 53 reported suites passed, including seven new
regressions for single/multiple-song menus, ordered playback, native heart
persistence and rejected-heart rollback. Browser preview confirmed both a
single-song artist and playlist omit Shuffle All, and a multi-song playlist
places Play All first. Record Keeper production returned HTTP 200 and contains
the fixes.

Generated using `npm run sync:recordkeeper:ios` from `native/`. Archive overrides:
`MARKETING_VERSION=1.0.0 CURRENT_PROJECT_VERSION=4`. Signed bundle identity and
version verified. Bundled index SHA-256:
`ba60178c114a5d8a0de1e5dd8566773b77420987fc779e7cf1c393e6aba0be9f`.

Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-06/Record Keeper 1.0.0 (4).xcarchive`.
Upload log: `/private/tmp/rk-release-upload-4.log`.

## Test notes

Open the Explore artist and playlist menus. Play All should precede Shuffle
All, preserve the list's order and turn shuffle off. A one-song list should not
offer Shuffle All. During playback, tap the heart and confirm the reaction is
saved without a Load failed toast. Check heart removal and background playback.

The native transport is covered by automated tests; an actual phone heart tap
has not been independently verified in this run.
