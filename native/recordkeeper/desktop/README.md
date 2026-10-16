# Record Keeper for the desktop

An Electron shell around https://recordkeeper.stream. It adds what a browser
tab cannot do: a system tray icon, closing to the tray with the music still
playing, and a Mini Player that can stay on top of other windows.

## How it is put together

| Piece | What it does |
|-------|--------------|
| `main.js` | The app window, the tray, the Mini Player window, settings, sign-in hand-off |
| `lib.js` | Pure helpers (URL checks, settings, state trimming). Tested by `tests/desktop-app.test.mjs` |
| `preload.js` | Gives the page `window.sjDesktop` |
| `mini/` | The Mini Player: a small local page that is a remote control, never a player |

- **The window loads the live site, it does not bundle `public/`.** YouTube
  embeds refuse to play from `file://`, and loading the site means every web
  deploy reaches the app straight away. The shell only needs a new release
  when something in this folder changes.
- **There is one player.** The Mini Player shows what the page reports
  (`desktop:state`, twice a second while it is open) and sends commands back
  (`toggle`, `next`, `prev`, `seek`, `heart`, `skipNext`). The state carries
  the song that is up next (`ytUpNextIndex()`, the same pick the player's
  banner shows), and Skip runs `ytSkipUpNext()`. The main window hides while it
  is up, which the page already handles exactly like a background browser tab:
  YouTube keeps going, and an uploaded file takes over where there is one.
- **The page side is `sjd*` in `public/index.html`.** `sjIsDesktop()` is
  deliberately not `sjIsNative()`: that one means the Capacitor phone shell
  and turns on native audio, downloads and CarPlay, none of which exist here.
- **Sign-in runs in the person's own browser.** Google refuses OAuth inside an
  embedded browser. The page's existing `sjNativeSignIn()` gets the bridge as
  its plugin, the system browser opens `/api/sj-auth-start`, and the callback
  returns on `com.johnnyoutlaw.recordkeeper://auth`, the same scheme the phone
  apps use (so it is already on the Supabase redirect list). On Windows the
  callback arrives as a second launch (`second-instance`); on the Mac as
  `open-url`.
- Only our own origins load in the window. Anything else opens in the browser.
  Only the main window, on our origin, may drive the shell over IPC.
- `backgroundThrottling` is off so the queue advances on time from the tray.
- The user agent ends in `RecordKeeperDesktop/<version>` instead of Electron's.
- Settings live in `desktop-settings.json` under the app's user data folder.
  The page may change only `tray`, `closeToTray`, `alwaysOnTop` and
  `minimizeToMini` (the minimize button opens the Mini Player). The page only
  shows a switch the shell reports, so an older install never gets a dead one.

## Run it

```bash
npm install
npm start                                   # against https://recordkeeper.stream
RK_DESKTOP_URL=http://localhost:3041 npm start   # against a dev server (SURFACE_ID=rk)
```

`RK_DESKTOP_PROFILE=<folder>` runs with a throwaway profile, so an automated
run never shares sign-in, settings or the single-instance lock with your copy.

## Release

1. Bump `version` here and `DESKTOP_APP.version` / `files.windows` in
   `src/lib/desktop-app.ts`. A test fails if the two disagree.
2. `npm run dist:win` builds `dist/Record-Keeper-Setup-<version>.exe`.
3. Create a GitHub release tagged `rk-desktop-v<version>` on
   `Johnny-Outlaw-LLC/suffering-jukebox` and attach the installer.
4. Push. `/api/desktop-download?platform=windows` now sends people to it.

The installer is **not code signed**, so Windows SmartScreen warns about an
unrecognized publisher. The download copy says so. A code signing certificate
fixes it; electron-builder signs automatically once `CSC_LINK` and
`CSC_KEY_PASSWORD` are set.

There is no auto-update. Web changes do not need one; when the shell itself
changes, people download the new installer.

## Mac

`npm run dist:mac` on the Mac builds a universal dmg. For anyone else to open
it, it must be signed with a Developer ID on team 2J69KHU242 and notarized
(set `CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
Then add the file name to `files.mac` in `src/lib/desktop-app.ts` and offer
the button in `sjdDownloadHTML()`. On the Mac the tray is the menu bar, and
the copy already says so when `platform` is `darwin`.
