'use strict';
// Pure helpers for the Record Keeper desktop shell. Nothing in here touches
// Electron, so tests/desktop-app.test.mjs can load it with plain Node.

const SITE_URL = 'https://recordkeeper.stream/';
// Must equal SURFACES.rk.authScheme in src/lib/surface.ts. The page builds its
// sign-in redirect from that value and the OS hands the callback to whichever
// app registered this scheme. A test holds the two together.
const AUTH_SCHEME = 'com.johnnyoutlaw.recordkeeper';
const APP_ORIGINS = ['https://recordkeeper.stream', 'https://www.recordkeeper.stream'];

const DEFAULT_SETTINGS = Object.freeze({
  tray: true,          // show an icon in the system tray
  closeToTray: true,   // closing the window keeps the music playing in the tray
  alwaysOnTop: false,  // the Mini Player floats above other windows
  trayNoticeShown: false,
  bounds: null,        // the full window, restored on launch
  maximized: false,
  miniPos: null,       // where the Mini Player was last left
});

const MINI_SIZE = Object.freeze({ width: 380, height: 136 });

/** Merge a saved file over the defaults, dropping anything we do not know. */
function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['tray', 'closeToTray', 'alwaysOnTop', 'trayNoticeShown', 'maximized']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  if (validRect(raw.bounds)) out.bounds = pickRect(raw.bounds);
  if (raw.miniPos && Number.isFinite(raw.miniPos.x) && Number.isFinite(raw.miniPos.y)) {
    out.miniPos = { x: Math.round(raw.miniPos.x), y: Math.round(raw.miniPos.y) };
  }
  return out;
}

/** The part of the settings the page may read and change. Window geometry stays in the shell. */
function publicSettings(s) {
  return { tray: !!s.tray, closeToTray: !!s.closeToTray, alwaysOnTop: !!s.alwaysOnTop };
}

/** Apply a change from the page, accepting only the three switches it owns. */
function applyPatch(s, patch) {
  const next = { ...s };
  if (patch && typeof patch === 'object') {
    for (const k of ['tray', 'closeToTray', 'alwaysOnTop']) {
      if (typeof patch[k] === 'boolean') next[k] = patch[k];
    }
  }
  return next;
}

function validRect(r) {
  return !!r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width >= 200 && r.height >= 120;
}
function pickRect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** Is this URL one of our own pages (so it may load in the app window)? */
function isAppUrl(url, extraOrigins = []) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const origin = u.origin;
  return APP_ORIGINS.includes(origin) || extraOrigins.includes(origin);
}

/** Links we hand to the system browser rather than ignore. */
function isExternalWebUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch { return false; }
}

/**
 * The sign-in callback, if one of these command-line arguments is it. On
 * Windows a second launch carries the URL in argv; macOS uses open-url instead.
 */
function findAuthCallback(argv) {
  for (const a of argv || []) {
    if (typeof a !== 'string') continue;
    if (a.toLowerCase().startsWith(AUTH_SCHEME + '://')) return a;
  }
  return null;
}

/**
 * Where sign-in may send the system browser. The page hands over our own
 * /api/sj-auth-start hop (which only forwards to the Supabase authorize URL)
 * or the authorize URL itself; nothing else is opened.
 */
function isAllowedSignInUrl(url, extraOrigins = []) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && extraOrigins.includes(u.origin))) return false;
  if (isAppUrl(url, extraOrigins) && u.pathname === '/api/sj-auth-start') return true;
  return u.hostname === 'ntyvtpimesfoesuykuyi.supabase.co' && u.pathname === '/auth/v1/authorize';
}

/** Bottom right of the work area, with a margin, for a Mini Player opened for the first time. */
function defaultMiniPos(workArea) {
  const m = 24;
  return {
    x: Math.round(workArea.x + workArea.width - MINI_SIZE.width - m),
    y: Math.round(workArea.y + workArea.height - MINI_SIZE.height - m),
  };
}

/** Keep a remembered position on a screen that still exists. */
function clampToArea(pos, size, area) {
  return {
    x: Math.min(Math.max(pos.x, area.x), area.x + area.width - size.width),
    y: Math.min(Math.max(pos.y, area.y), area.y + area.height - size.height),
  };
}

/** Tray tooltip: Windows caps it at 127 characters. */
function trayTooltip(state, appName = 'Record Keeper') {
  if (!state || !state.title) return appName;
  const line = state.artist ? `${state.title} - ${state.artist}` : state.title;
  const full = `${appName}\n${state.playing ? '' : 'Paused: '}${line}`;
  return full.length > 127 ? full.slice(0, 126) + '…' : full;
}

/** The page's player state, trimmed to what the Mini Player and tray read. */
function sanitizeState(s) {
  if (!s || typeof s !== 'object' || !s.has) return { has: false };
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);
  let art = str(s.art, 2000);
  if (art && !/^https:\/\//i.test(art)) art = '';
  return {
    has: true,
    title: str(s.title, 300),
    artist: str(s.artist, 300),
    art,
    playing: !!s.playing,
    pos: num(s.pos),
    dur: num(s.dur),
    hearted: !!s.hearted,
    canHeart: !!s.canHeart,
  };
}

module.exports = {
  SITE_URL, AUTH_SCHEME, APP_ORIGINS, DEFAULT_SETTINGS, MINI_SIZE,
  normalizeSettings, publicSettings, applyPatch,
  isAppUrl, isExternalWebUrl, findAuthCallback, isAllowedSignInUrl,
  defaultMiniPos, clampToArea, trayTooltip, sanitizeState,
};
