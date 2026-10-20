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
  banner shows), and Skip runs `ytSkipUpNext()`.
- **The Mini Player's ⋯ is the page's own ⋯ menu, drawn natively.** The shell
  asks the page for `sjdMenuItems()`, which opens the real player menu out of
  sight and reads it (the Add to playlist fly-out included), and a pick runs
  `sjdMenuRun([label])` by clicking that same button. When the click opens a
  dialog, a fly-out or a new page, the main window comes back to finish it. So
  a new action in `sjmRenderRoot()` reaches the Mini Player with no change here. The main window hides while it
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

Each platform is built on its own OS and can ship on its own. `DESKTOP_APP`
in `src/lib/desktop-app.ts` names a version per platform; `version` there and
here in `package.json` is the newest of them. A test fails if they disagree or
a file name does not match electron-builder's `artifactName`.

1. Bump `version` here and `DESKTOP_APP.version`, plus the entry for the
   platform you are building in `DESKTOP_APP.builds`.
2. Build it (below).
3. Create a GitHub release tagged `rk-desktop-v<version>` on
   `Johnny-Outlaw-LLC/suffering-jukebox` and attach the file. When the other
   platform catches up to the same version, attach its file to that release.
4. Push. `/api/desktop-download?platform=windows|mac` now sends people to it;
   with no platform it picks the visitor's own from the user agent.

There is no auto-update. Web changes do not need one; when the shell itself
changes, people download the new installer.

### Windows

`npm run dist:win` on Windows builds `dist/Record-Keeper-Setup-<version>.exe`.

The installer is **not code signed**, so Windows SmartScreen warns about an
unrecognized publisher. The download copy says so. A code signing certificate
fixes it; electron-builder signs automatically once `CSC_LINK` and
`CSC_KEY_PASSWORD` are set.

### Mac

`npm run dist:mac` on a Mac builds `dist/Record-Keeper-<version>.dmg`: one
universal app (Apple silicon and Intel), macOS 13 or later, signed with
**Developer ID Application: Johnny Outlaw LLC (2J69KHU242)** under the hardened
runtime, notarized and stapled, inside a dmg that is itself signed, notarized
and stapled. A stranger downloads it, drags the app to Applications and it
opens with no warning. `scripts/dist-mac.cjs` checks the certificate and the
notary credentials before it builds anything, and ends with Gatekeeper's own
verdict on the app and the dmg.

Notarization reads a `notarytool` keychain profile, by default
`shutterfield-notary` (it is per Apple ID, not per app, so Shutterfield's
serves). `RK_NOTARY_PROFILE` names another. On a Mac without one, store it
once; it asks for an app-specific password from https://account.apple.com:

```bash
xcrun notarytool store-credentials "shutterfield-notary" --apple-id "johnnyoutlawllc@gmail.com" --team-id 2J69KHU242
```

`RK_SKIP_NOTARIZE=1 npm run dist:mac` signs without notarizing, to test a
packaging change in a minute instead of ten. That dmg warns on every other Mac:
never publish it.

What differs on the Mac:

- The tray is the menu bar. Its icon is `assets/trayTemplate.png`, black and
  alpha only, which macOS tints for a light or dark menu bar. A click opens the
  menu, as for every menu bar icon.
- Closing the window hides it whatever the tray setting; the Dock icon brings
  it back. Quit with Cmd+Q or from the menu bar.
- The app icon is `build/icon-mac.png`, the record on Apple's rounded-square
  grid, so macOS does not put a round icon on a gray tile.
- With Always on Top, the Mini Player also follows you to other Spaces.
- The sign-in callback arrives as `open-url`; the scheme is registered in the
  app's Info.plist from `build.protocols`.

`scripts/render-mac-icons.py` redraws both Mac icons from the logo.
