# Record Keeper 1.0.1 (8)

- App Store Connect app: 6819821388
- Bundle ID: com.johnnyoutlaw.recordkeeper
- Web source commit: ad7a305
- Uploaded October 11, 2026 at 8:29 AM America/Chicago. Xcode reported
  `Upload succeeded` and `EXPORT SUCCEEDED`.
- Replaces build 7 on version 1.0.1.

Fixes the full player's timer for songs played by the native audio engine
(artist uploads): the scrubber read the paused WebView <audio> element and
sat at 0:00 / 0:00. It now follows AVPlayer's reported position and
duration, and a scrub release seeks AVPlayer.

Device check on Magic (development build of the same source): user confirmed
the timer counts and shows the song length while a Nouns Group song plays.
508 web tests pass.

Generated with `npm run sync:recordkeeper:ios`; archive overrides:
`MARKETING_VERSION=1.0.1 CURRENT_PROJECT_VERSION=8`.
Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-11/Record Keeper 1.0.1 (8).xcarchive`.

## Submission

- Build 8 replaced build 7 on version 1.0.1 (build 7 stays in TestFlight).
- Submitted for review October 11, 2026 at about 8:37 AM America/Chicago;
  status Waiting for Review. Release: automatically after approval.
