# Listening Party 1.0.2 (25)

- App Store Connect app: 6817111259
- Bundle ID: com.johnnyoutlaw.sufferingjukebox
- Signing team: 2J69KHU242
- Web source commit: e7053872f849101587bd50ba2b61f32d43a25b03
- Uploaded October 6, 2026 at 4:06 PM America/Chicago.
- Xcode reported `Upload succeeded` and `EXPORT SUCCEEDED`.
- Apple processing completed; TestFlight shows 1.0.2 (25), Ready to Submit.
- Build ID: 976a3b64-ae6d-4399-b684-981182c56314
- No tester groups or individual testers are assigned.
- TestFlight's What to Test notes are saved; the tester wizard is awaiting review information.
- App Store version 1.0.2 is created in Prepare for Submission with build 25 and release notes saved.
- This upload does not replace the approved App Store version 1.0.1.

This release removes decorative icons from the song menus, removes the redundant
Download for CarPlay offer, and refreshes artist artwork after metadata loads.
Existing offline-download removal remains available.

The archive bundles the exact tested production source, staged with
`native/scripts/build-web.mjs` and Capacitor's iOS copy command. The release
commit passed all 505 web and native checks. The bundled index SHA-256 is
`9cebee2efd040bb7069fb91ae7618ee65fbb45ded8c451e03bf734ff6eff6133`.
Unrelated pending local sign-in and playlist changes are excluded.

Archive: `/Users/outlaw/Library/Developer/Xcode/Archives/2026-10-06/Listening Party 1.0.2 (25).xcarchive`.
Upload log: `/private/tmp/sj-menu-artwork-upload.log`.
The archive is preserved in Xcode’s Archives folder; the upload log is temporary.

## Test notes

Play a Nouns Group recording and confirm its album cover appears in both the
player and mini player. Open the song’s ⋯ menu and confirm decorative icons
are absent and available audio has no Download for CarPlay offer. Existing
offline downloads should still offer Remove download.
