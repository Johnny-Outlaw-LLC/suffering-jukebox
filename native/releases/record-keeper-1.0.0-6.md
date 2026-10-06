# Record Keeper 1.0.0 (6)

- App Store Connect app: 6819821388
- Bundle ID: com.johnnyoutlaw.recordkeeper
- Web source commit: 1f4ae1d
- Uploaded successfully October 6, 2026 at 5:54 PM America/Chicago; Apple processing is pending.
- Magic installation failed after its device connection dropped; a retry timed out and device listing reports unavailable. Build 6 installation is not confirmed.
- Production Record Keeper verified with the final heart-first runtime order.
- Build 3 remains in Apple review, as requested.

Final compact dock order: heart, pause/play, next, close. The heart is the
leftmost icon, matching the user's follow-up. Shared reaction counts are
visible in both player sizes and synchronized with confirmed heart saves.
Long-press undo retains the existing reaction behavior.

Validation: all 505 checks in 53 reported suites passed, including native
reaction save/rollback, counts increasing from 1 to 2 across both player sizes,
and the runtime dock arrangement putting heart before pause. Browser playback
automation stalled, so actual phone heart taps were not independently verified.

Generated with `npm run sync:recordkeeper:ios`; archive overrides:
`MARKETING_VERSION=1.0.0 CURRENT_PROJECT_VERSION=6`.
Bundled index SHA-256:
`8ab3d1ff8cc93c5a1aa08a04d3b0549b9038b940aecf7c85a914196d25d0de02`.

Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-06/Record Keeper 1.0.0 (6).xcarchive`.
Upload log: `/private/tmp/rk-release-upload-6.log`.
