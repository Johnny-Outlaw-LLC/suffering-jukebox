'use strict';
// Record Keeper for the desktop.
//
// A shell around the live site, not a copy of it: the window loads
// https://recordkeeper.stream, so every web deploy reaches the app the moment
// it ships and YouTube embeds play from a real https origin (they refuse
// file://). What the shell adds is what a browser tab cannot do: a tray icon,
// closing to the tray with the music still playing, and a Mini Player that can
// float above other windows.
//
// The Mini Player is a small window of its own (mini/), a remote control for
// the player in the main window. It never plays anything itself, so there is
// still exactly one player and one queue. The main window hides while it is
// up, which the page already treats exactly like a backgrounded browser tab.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const L = require('./lib');

const START_URL = process.env.RK_DESKTOP_URL || L.SITE_URL;
// A dev server (RK_DESKTOP_URL=http://localhost:3021) counts as our own origin.
const EXTRA_ORIGINS = (() => {
  try {
    const o = new URL(START_URL).origin;
    return L.APP_ORIGINS.includes(o) ? [] : [o];
  } catch { return []; }
})();
const APP_NAME = 'Record Keeper';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const IS_MAC = process.platform === 'darwin';

let win = null;          // the app
let mini = null;         // the Mini Player
let miniOpen = false;
let tray = null;
let quitting = false;
let settings = { ...L.DEFAULT_SETTINGS };
let playerState = { has: false };
let pendingAuth = null;  // { resolve, reject, timer } while the system browser is signing in
let lastTrayKey = '';

// A throwaway profile for automated runs, so they never share sign-in,
// settings or the single-instance lock with the copy someone actually uses.
if (process.env.RK_DESKTOP_PROFILE) app.setPath('userData', process.env.RK_DESKTOP_PROFILE);

// ── Single instance + the sign-in callback ─────────────────────────────────
// The sign-in callback arrives as a second launch on Windows (the URL is in
// argv) and as open-url on macOS. Either way it must reach the running app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const cb = L.findAuthCallback(argv);
    if (cb) handleAuthCallback(cb);
    else showMain();
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (app.isReady()) handleAuthCallback(url);
    else app.once('ready', () => setTimeout(() => handleAuthCallback(url), 1500));
  });
  registerProtocol();
  app.whenReady().then(start);
}

function registerProtocol() {
  // Running from source (electron .) the scheme has to name the script too,
  // or the OS would launch a bare Electron with nothing to open.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(L.AUTH_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(L.AUTH_SCHEME);
  }
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId('com.johnnyoutlaw.recordkeeper.desktop');
  settings = loadSettings();
  // Say who we are in the user agent rather than as "Electron": the site's
  // analytics then counts desktop listeners, and nothing treats the window as
  // an unknown embedded browser.
  app.userAgentFallback = app.userAgentFallback
    .replace(/ Electron\/\S+/, '')
    .replace(/ Record Keeper\/\S+/, '')
    .replace(/ record-keeper-desktop\/\S+/, '') + ' RecordKeeperDesktop/' + app.getVersion();

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(L.isAppUrl(details.requestingUrl || wc.getURL(), EXTRA_ORIGINS));
  });

  setAppMenu();
  createMain();
  if (settings.tray) createTray();
  wireIpc();

  // Launched by the sign-in callback itself (the app was not running).
  const cb = L.findAuthCallback(process.argv);
  if (cb) win.webContents.once('did-finish-load', () => handleAuthCallback(cb));

  app.on('activate', () => showMain());
}

app.on('before-quit', () => {
  quitting = true;
  saveBounds();
  saveSettingsNow();
});
app.on('window-all-closed', () => {
  if (quitting || !IS_MAC) app.quit();
});

// ── Settings file ──────────────────────────────────────────────────────────
function settingsPath() { return path.join(app.getPath('userData'), 'desktop-settings.json'); }
function loadSettings() {
  try { return L.normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))); }
  catch { return L.normalizeSettings(null); }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 400);
}
function saveSettingsNow() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (_) {}
}

// ── Menus ──────────────────────────────────────────────────────────────────
function setAppMenu() {
  // Windows and Linux need no menu bar; copy and paste work in the page
  // without one. The Mac needs the standard menus for its shortcuts.
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { label: 'Mini Player', accelerator: 'Cmd+Shift+M', click: () => toggleMini() }] },
    { role: 'windowMenu' },
  ]));
}

// ── The main window ────────────────────────────────────────────────────────
function createMain() {
  const b = visibleBounds(settings.bounds);
  win = new BrowserWindow({
    width: b?.width || 1280,
    height: b?.height || 820,
    x: b?.x,
    y: b?.y,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: '#171717',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The queue advances on timers. A hidden window must not throttle them,
      // or the next song would start a minute late from the tray.
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!miniOpen) win.show(); });
  win.loadURL(START_URL);

  const wc = win.webContents;
  wc.on('will-navigate', (e, url) => {
    if (L.isAppUrl(url, EXTRA_ORIGINS)) return;
    e.preventDefault();
    if (L.isExternalWebUrl(url)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    // Our own pages (My Data & Analytics opens in a new tab) open in an app
    // window that shares the sign-in. Everything else goes to the browser.
    if (L.isAppUrl(url, EXTRA_ORIGINS)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          icon: ICON, backgroundColor: '#171717', autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    if (L.isExternalWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (e, input) => {
    if (isMiniShortcut(input)) { e.preventDefault(); toggleMini(); }
  });

  win.on('close', (e) => {
    saveBounds();
    if (quitting) return;
    if (settings.tray && settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
      if (!settings.trayNoticeShown && process.platform === 'win32') {
        tray.displayBalloon({
          iconType: 'info',
          title: APP_NAME,
          content: 'Still playing. Click the tray icon to come back, or right-click it to quit.',
        });
        settings.trayNoticeShown = true;
        saveSettings();
      }
      return;
    }
    if (IS_MAC) { e.preventDefault(); win.hide(); return; }
    quitting = true;
    app.quit();
  });
  win.on('resize', () => saveBoundsSoon());
  win.on('move', () => saveBoundsSoon());
  win.on('maximize', () => { settings.maximized = true; saveSettings(); });
  win.on('unmaximize', () => { settings.maximized = false; saveSettings(); });
}

function isMiniShortcut(input) {
  return input.type === 'keyDown' && (input.control || input.meta) && input.shift && String(input.key).toLowerCase() === 'm';
}

let boundsTimer = null;
function saveBoundsSoon() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveBounds, 500);
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || !win.isVisible()) return;
  settings.bounds = win.getBounds();
  saveSettings();
}

/** A remembered size and place, unless the screen it was on has gone. */
function visibleBounds(b) {
  if (!b) return null;
  const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return centre.x >= a.x && centre.x <= a.x + a.width && centre.y >= a.y && centre.y <= a.y + a.height;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}

function showMain() {
  if (!win || win.isDestroyed()) return;
  if (miniOpen) { closeMini(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── Mini Player ────────────────────────────────────────────────────────────
function createMini() {
  mini = new BrowserWindow({
    width: L.MINI_SIZE.width,
    height: L.MINI_SIZE.height,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: `${APP_NAME} Mini Player`,
    icon: ICON,
    backgroundColor: '#171717',
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'mini', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mini.loadFile(path.join(__dirname, 'mini', 'mini.html'));
  mini.webContents.on('will-navigate', (e) => e.preventDefault());
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mini.webContents.on('before-input-event', (e, input) => {
    if (isMiniShortcut(input)) { e.preventDefault(); toggleMini(); }
  });
  mini.on('moved', () => {
    const [x, y] = mini.getPosition();
    settings.miniPos = { x, y };
    saveSettings();
  });
  mini.on('close', (e) => {
    if (quitting) return;
    // Alt+F4 on the Mini Player means "back to the big window", not quit.
    e.preventDefault();
    closeMini();
  });
}

function openMini() {
  if (!mini || mini.isDestroyed()) createMini();
  const size = L.MINI_SIZE;
  const display = settings.miniPos
    ? screen.getDisplayNearestPoint(settings.miniPos)
    : screen.getDisplayMatching(win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 1, height: 1 });
  const area = display.workArea;
  const pos = L.clampToArea(settings.miniPos || L.defaultMiniPos(area), size, area);
  mini.setPosition(pos.x, pos.y);
  applyAlwaysOnTop();
  miniOpen = true;
  mini.show();
  if (win && !win.isDestroyed()) { saveBounds(); win.hide(); }
  sendMini('mini:state', playerState);
  broadcastMini();
}

function closeMini() {
  miniOpen = false;
  if (mini && !mini.isDestroyed()) mini.hide();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  broadcastMini();
}

function toggleMini() { if (miniOpen) closeMini(); else openMini(); }

function applyAlwaysOnTop() {
  if (mini && !mini.isDestroyed()) mini.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
}

function broadcastMini() {
  sendPage('desktop:mini', miniOpen);
  updateTray(true);
}

// ── Tray ───────────────────────────────────────────────────────────────────
function createTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.on('click', () => {
    if (miniOpen && mini && !mini.isDestroyed()) { mini.show(); mini.focus(); return; }
    if (win && win.isVisible() && win.isFocused()) win.hide();
    else showMain();
  });
  updateTray(true);
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
  lastTrayKey = '';
}

function updateTray(force) {
  if (!tray) return;
  const s = playerState;
  const key = JSON.stringify([s.has, s.title, s.artist, s.playing, miniOpen, settings.alwaysOnTop]);
  if (!force && key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setToolTip(L.trayTooltip(s, APP_NAME));
  const now = s.has
    ? (s.artist ? `${s.title} - ${s.artist}` : s.title)
    : 'Nothing playing';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: now.length > 60 ? now.slice(0, 59) + '…' : now, enabled: false },
    { type: 'separator' },
    { label: s.playing ? 'Pause' : 'Play', enabled: !!s.has, click: () => sendCommand('toggle') },
    { label: 'Next', enabled: !!s.has, click: () => sendCommand('next') },
    { label: 'Previous', enabled: !!s.has, click: () => sendCommand('prev') },
    { type: 'separator' },
    { label: `Show ${APP_NAME}`, click: () => showMain() },
    { label: 'Mini Player', type: 'checkbox', checked: miniOpen, click: () => toggleMini() },
    { label: 'Always on Top', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (item) => changeSettings({ alwaysOnTop: item.checked }) },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => { quitting = true; app.quit(); } },
  ]));
}

// ── Talking to the page and the Mini Player ────────────────────────────────
function sendPage(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendMini(channel, ...args) {
  if (mini && !mini.isDestroyed()) mini.webContents.send(channel, ...args);
}
function sendCommand(cmd, arg) {
  if (!['toggle', 'next', 'prev', 'seek', 'heart'].includes(cmd)) return;
  sendPage('desktop:command', cmd, arg);
}

function settingsPayload() {
  return { ...L.publicSettings(settings), miniOpen, version: app.getVersion(), platform: process.platform };
}

function changeSettings(patch) {
  const before = settings;
  settings = L.applyPatch(settings, patch);
  if (settings.tray && !tray) createTray();
  if (!settings.tray && tray) {
    destroyTray();
    // With no tray to come back from, a hidden window would be lost.
    if (win && !win.isDestroyed() && !win.isVisible() && !miniOpen) showMain();
  }
  if (before.alwaysOnTop !== settings.alwaysOnTop) applyAlwaysOnTop();
  saveSettings();
  const payload = settingsPayload();
  sendPage('desktop:settings', payload);
  sendMini('mini:settings', payload);
  updateTray(true);
  return payload;
}

/** Only the app window may drive the shell, and only while it is on our own site. */
function fromPage(e) {
  return !!win && !win.isDestroyed() && e.sender === win.webContents
    && L.isAppUrl(e.senderFrame?.url || win.webContents.getURL(), EXTRA_ORIGINS);
}
function fromMini(e) {
  return !!mini && !mini.isDestroyed() && e.sender === mini.webContents;
}

function wireIpc() {
  ipcMain.handle('desktop:getSettings', (e) => (fromPage(e) || fromMini(e)) ? settingsPayload() : null);
  ipcMain.handle('desktop:setSettings', (e, patch) => (fromPage(e) || fromMini(e)) ? changeSettings(patch) : null);
  ipcMain.handle('desktop:mini', (e, open) => {
    if (!fromPage(e) && !fromMini(e)) return false;
    if (open) openMini(); else closeMini();
    return miniOpen;
  });
  ipcMain.on('desktop:state', (e, state) => {
    if (!fromPage(e)) return;
    playerState = L.sanitizeState(state);
    sendMini('mini:state', playerState);
    updateTray(false);
  });
  ipcMain.handle('desktop:signIn', (e, opts) => (fromPage(e) ? startSignIn(opts) : Promise.reject(new Error('Not allowed'))));

  ipcMain.on('mini:command', (e, cmd, arg) => { if (fromMini(e)) sendCommand(cmd, arg); });
  ipcMain.on('mini:expand', (e) => { if (fromMini(e)) closeMini(); });
  ipcMain.on('mini:ready', (e) => {
    if (!fromMini(e)) return;
    sendMini('mini:settings', settingsPayload());
    sendMini('mini:state', playerState);
  });
}

// ── Sign-in through the system browser ─────────────────────────────────────
// Google refuses OAuth inside an embedded browser, so sign-in runs in the
// person's own browser and comes back on com.johnnyoutlaw.recordkeeper://auth,
// exactly the way the phone apps do it. The page keeps the PKCE verifier and
// does the code exchange itself; the shell only carries the URL both ways.
function startSignIn(opts) {
  const url = String(opts?.url || '');
  if (!L.isAllowedSignInUrl(url, EXTRA_ORIGINS)) return Promise.reject(new Error('Sign-in address not allowed'));
  if (pendingAuth) {
    clearTimeout(pendingAuth.timer);
    pendingAuth.reject(new Error('Sign-in cancelled'));
    pendingAuth = null;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingAuth?.timer === timer) pendingAuth = null;
      reject(new Error('Sign-in cancelled'));
    }, 10 * 60 * 1000);
    pendingAuth = { resolve, reject, timer };
    shell.openExternal(url).catch((err) => {
      clearTimeout(timer);
      pendingAuth = null;
      reject(err);
    });
  });
}

function handleAuthCallback(url) {
  if (!url) return;
  if (pendingAuth) {
    const p = pendingAuth;
    pendingAuth = null;
    clearTimeout(p.timer);
    p.resolve({ url });
    showMain();
    return;
  }
  // No sign-in is waiting (the app was restarted mid-way). The verifier is
  // still in the page's storage, and the page exchanges a ?code= on load.
  try {
    const cb = new URL(url);
    const code = cb.searchParams.get('code');
    if (code && win && !win.isDestroyed()) {
      const target = new URL('/', START_URL);
      target.searchParams.set('code', code);
      win.loadURL(target.toString());
    }
  } catch (_) {}
  showMain();
}
