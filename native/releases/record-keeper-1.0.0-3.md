# Record Keeper 1.0.0 (3)

- App Store Connect app: 6819821388
- Bundle ID: com.johnnyoutlaw.recordkeeper
- Signing team: 2J69KHU242
- Web source commit: 7996ebb
- Uploaded October 6, 2026 at 4:23 PM America/Chicago.
- Xcode reported `Upload succeeded` and `EXPORT SUCCEEDED`.
- Apple processing completed; TestFlight shows build 3, Ready to Submit.
- Build ID: 2a800ed7-4923-4384-bfca-add8c13eb2fe.
- What to Test notes are saved; no testers are assigned yet.
- Original App Store submission (build 1) withdrawn with user authorization.
- Version 1.0.0 build 3 submitted October 6, 2026 at 5:12 PM America/Chicago.
- Apple confirmed `1 Item Submitted`; status Waiting for Review.
- Submission ID: 9535e826-431f-477e-ad6d-00577178a8e9.

Includes the simplified song menu, removal of redundant Download for CarPlay,
Nouns Group artwork hydration, native sign-in fixes, and audio-only playlist
playback. All 514 repository checks passed before the archive was created.
Record Keeper production returned HTTP 200 and contains the menu and playlist fixes.

Generated using `npm run sync:recordkeeper:ios` from the maintained native sources.
Archive settings explicitly override `MARKETING_VERSION=1.0.0` and
`CURRENT_PROJECT_VERSION=3`; the generation script defaults to build 1.
The signed archive was verified to use the Record Keeper display name and bundle ID.
Bundled index SHA-256: `498ed53f6030ae914ee1f7e43cef0135ab9ba9a92d77e596d0352820f4eb0386`.

Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-06/Record Keeper 1.0.0 (3).xcarchive`.
Upload log: `/private/tmp/rk-release-upload-3.log`.

## Test notes

Confirm Nouns Group album artwork appears in the player and mini player.
Open the song menu: decorative icons should be absent, and available audio
should not offer Download for CarPlay. Existing offline downloads should still
offer Remove download. Test email sign-in and playlists containing artist
recordings without YouTube IDs, including Play Next, shuffle, background audio,
and CarPlay.

## Review preparation

The existing metadata, screenshots, privacy settings and App Store review details
were retained. Apple accepted build 3 for App Store review. The user opted to skip
tester invitations and TestFlight beta review because only personal testing is
needed. No beta review submission was sent.

Submission: https://appstoreconnect.apple.com/apps/6819821388/distribution/reviewsubmissions/details/9535e826-431f-477e-ad6d-00577178a8e9
