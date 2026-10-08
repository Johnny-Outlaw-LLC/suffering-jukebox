# Record Keeper 1.0.1 (7)

- App Store Connect app: 6819821388
- Bundle ID: com.johnnyoutlaw.recordkeeper
- Web source commit: 7682284
- Uploaded October 8, 2026 at 12:30 PM America/Chicago. Xcode reported
  `Upload succeeded` and `EXPORT SUCCEEDED`.
- 1.0.0 (3) went live on the App Store October 8, 2026. Build 6 was marked
  1.0.0 and cannot ship against the 1.0.1 version, so build 7 replaces it with
  the same player and heart code.

Includes everything from builds 4-6 (ordered Play All, native heart saves,
heart-first compact dock with shared counts). The web bundle also carries the
recordkeeper.stream App Store badge, which is hidden inside the native app.

Simulator check (iPhone 17 Pro Max): Home, Explore, YouTube playback with
synced lyrics and the heart-first dock all render. Native audio for an
artist-uploaded song played (AVPlayer reached 45 s) but the expanded player
showed 0:00 / 0:00 for its whole first pass; YouTube playback timers were
correct. Needs a device check before submission.

Store copy approved October 8 and recorded in
`native/recordkeeper/store/listing.json` (subtitle, keywords, promotional
text, What's New). Captioned 6.9" screenshots are in
`capture/record-keeper-appstore/1.0.1/`.

Generated with `npm run sync:recordkeeper:ios`; archive overrides:
`MARKETING_VERSION=1.0.1 CURRENT_PROJECT_VERSION=7`.
Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-08/Record Keeper 1.0.1 (7).xcarchive`.
