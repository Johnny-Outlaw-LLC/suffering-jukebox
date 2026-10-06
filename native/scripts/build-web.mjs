// Stages the web app into www/ for Capacitor.
//
// The shell ships inside the binary rather than being loaded from the live
// site: that is what makes the app usable offline, and a remote-URL wrapper is
// the exact shape Apple rejects under 4.2. Data still comes from Supabase at
// runtime; only the shell is bundled.
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here   = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const web    = resolve(appDir, '..', 'public');
const www    = resolve(appDir, 'www');

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
await cp(web, www, { recursive: true });

// og-image.png is ~1.9 MB and only ever used by crawlers reading meta tags.
await rm(resolve(www, 'og-image.png'), { force: true });

const indexPath = resolve(www, 'index.html');
let html = await readFile(indexPath, 'utf8');

// The native product is the Listening Party surface. On the web, Next stamps
// this object into the shared HTML according to the request hostname. The
// bundled shell never passes through Next, so publish the same surface here.
const LISTENING_PARTY = {
  id: 'lp',
  name: 'Listening Party',
  url: 'https://listeningparty.stream',
  host: 'listeningparty.stream',
  origins: ['https://listeningparty.stream', 'https://www.listeningparty.stream'],
  tagline: 'Join the Listening Party',
  headerTitle: '',
  textLogo: '/brand/lp/listening-party-text-logo.png',
  icon: '/brand/lp/favicon.png',
  themeColor: '#4A1B6D',
  accent: '#FF5E14',
  accentHover: '#FF7A3A',
  accentRgb: '255,94,20',
  authScheme: 'com.johnnyoutlaw.listeningparty',
  shareText: 'Listening Party - music straight from independent artists, with the lyrics. Free, no ads.',
  redditSub: null,
  sisterName: 'Suffering Jukebox',
  sisterUrl: 'https://sufferingjukebox.stream/',
  features: {
    artistPages: false,
    artistJukebox: true,
    exploreSongs: true,
    homeTab: true,
    defaultLandingTab: 'home',
    playlistsFirst: true,
    shareImages: false,
    sitemapPlaylists: true,
    welcomeHero: true,
    phoneMiniPlayer: true,
    spotifyImport: false,
    artistUpload: true,
    liveStations: true,
  },
};

// Marker must be distinct from the app's own reads of window.__SJ_NATIVE__ -
// the web source references that name, so testing for the bare name matched
// the app's own code and silently skipped the injection, leaving the shell
// running in web mode.
const MARKER = 'sj-native-flag';
const FLAG = `<style>:root{--accent:#FF5E14;--accent-hover:#FF7A3A;--accent-rgb:255,94,20}</style>` +
  `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Figtree:wght@400;500;600;700;800&family=Lilita+One&display=swap">` +
  `<script id="${MARKER}">document.documentElement.setAttribute('data-surface','lp');` +
  `window.__SJ_NATIVE__=true;window.__SURFACE__=${JSON.stringify(LISTENING_PARTY).replace(/</g, '\\u003c')};</script>`;
if (!html.includes(`id="${MARKER}"`)) {
  html = html.replace('<head>', `<head>\n${FLAG}`);
  if (!html.includes(`id="${MARKER}"`)) {
    throw new Error('could not inject native flag: no <head> found');
  }
}
await writeFile(indexPath, html);

console.log(`staged ${web} -> ${www}`);
