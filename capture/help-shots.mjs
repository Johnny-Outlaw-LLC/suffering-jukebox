// Johnny Outlaw, LLC — Suffering Jukebox — help page screenshots.
//
// Sister script to capture.mjs. That one photographs artist jukeboxes nightly
// and publishes them to B2. This one photographs the APP'S OWN CHROME - menus,
// modals, the player - and writes straight into public/images/help/, because
// those pictures belong in the repo next to the page that uses them.
//
// It is not on a schedule. Run it by hand after a UI change that alters one of
// the screens below, then commit the PNGs:
//
//   cd capture && node help-shots.mjs
//   node help-shots.mjs --base http://localhost:3000     # against a dev server
//   node help-shots.mjs --only share-hub,export-image    # just these
//   node help-shots.mjs --keep-open                      # watch it work
//
// Everything here is captured SIGNED OUT, on purpose: it needs no credentials,
// it is what a new reader sees, and it cannot leak an account into a picture.
// Screens that only exist behind sign-in (Add Music step 2, the Online Jukebox
// console, Manage My Artists) are deliberately NOT here - the help page uses
// prose and diagrams for those rather than a faked screenshot.

import { chromium } from 'playwright';
import { mkdirSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'images', 'help');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = (flag('base', 'https://www.sufferingjukebox.stream')).replace(/\/$/, '');
const ONLY = (flag('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const KEEP_OPEN = args.includes('--keep-open');
const ARTIST = flag('artist', 'silver-jews');

// Playwright takes the size under `viewport`, not as bare width/height. Spread
// these straight into newContext(); a stray top-level width silently leaves you
// on the default 1280x720, which is how the first run produced a "phone"
// screenshot shaped like a laptop.
const DESKTOP = { viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const log = (...a) => console.log(...a);

/** Wait for the app to have finished its first render. */
async function ready(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.render === 'function', null, { timeout: 45000 });
  await page.waitForTimeout(2500);
  // Dismiss anything that opened over the top on first visit.
  await page.evaluate(() => {
    document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));
    document.getElementById('sj-cookie-bar')?.remove();
  }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Open an artist jukebox and wait for the chart to be on screen. */
async function openArtist(page) {
  await page.goto(`${BASE}/${ARTIST}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready(page);
  await page.waitForSelector('.view-seg', { timeout: 30000 });
  await page.waitForTimeout(1200);
}

/**
 * Every shot is { id, viewport, run(page) -> Locator|null }.
 * Returning a Locator clips the picture to that element; returning null takes
 * the whole viewport.
 */
const SHOTS = [
  {
    id: 'home-grid',
    viewport: DESKTOP,
    async run(page) {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await ready(page);
      await page.waitForSelector('.landing-card', { timeout: 30000 });
      await page.waitForTimeout(2500);
      return null;
    },
  },
  {
    id: 'view-menu',
    viewport: DESKTOP,
    async run(page) {
      await openArtist(page);
      const caret = page.locator('.vseg-caret-btn').first();
      await caret.click();
      await page.waitForSelector('.vdd-menu.open', { timeout: 8000 });
      await page.waitForTimeout(500);
      return null;
    },
  },
  {
    id: 'track-menu',
    viewport: DESKTOP,
    async run(page) {
      await openArtist(page);
      // Open one album's songs, then one song's panel, then its ⋯ menu.
      await page.evaluate(() => window.expandAllTracks && window.expandAllTracks());
      await page.waitForTimeout(1200);
      const line = page.locator('.trk-line').first();
      await line.scrollIntoViewIfNeeded();
      await line.click();
      await page.waitForTimeout(900);
      const more = page.locator('button.sc-link', { hasText: 'Playlist' }).first();
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await page.waitForSelector('#sjm-menu', { timeout: 8000 });
      await page.waitForTimeout(600);
      return null;
    },
  },
  {
    id: 'player-desktop',
    viewport: DESKTOP,
    async run(page) {
      await openArtist(page);
      await page.evaluate(() => window.shuffleAllVisible && window.shuffleAllVisible());
      await page.waitForSelector('#ytp-mini-footer', { state: 'visible', timeout: 30000 });
      // Give the YouTube iframe time to paint a frame and the lyrics to land.
      await page.waitForTimeout(11000);
      return null;
    },
  },
  {
    id: 'player-mobile',
    viewport: PHONE,
    async run(page) {
      await openArtist(page);
      await page.evaluate(() => window.shuffleAllVisible && window.shuffleAllVisible());
      await page.waitForSelector('#ytp-mini-footer', { state: 'visible', timeout: 30000 });
      await page.waitForTimeout(11000);
      return null;
    },
  },
  {
    id: 'share-hub',
    viewport: DESKTOP,
    async run(page) {
      await openArtist(page);
      await page.evaluate(() => window.openSjShareHub && window.openSjShareHub());
      await page.waitForSelector('#sjShareHubOverlay.open .pl-modal', { timeout: 10000 });
      await page.waitForTimeout(600);
      return page.locator('#sjShareHubOverlay .pl-modal').first();
    },
  },
  {
    id: 'export-image',
    viewport: DESKTOP,
    async run(page) {
      await openArtist(page);
      await page.evaluate(() => window.openSjExportModal && window.openSjExportModal());
      await page.waitForSelector('#sjExportOverlay.open .pl-modal', { timeout: 15000 });
      await page.waitForTimeout(2500);
      return page.locator('#sjExportOverlay .pl-modal').first();
    },
  },
  {
    id: 'import-doors',
    viewport: DESKTOP,
    async run(page) {
      await openArtist(page);
      // openImportMusic() bounces a signed-out visitor to the sign-in prompt,
      // so show the window itself. The markup is static, so this is exactly
      // what a signed-in listener sees.
      await page.evaluate(() => document.getElementById('importMusicOverlay')?.classList.add('open'));
      await page.waitForTimeout(600);
      return page.locator('#importMusicOverlay .modal').first();
    },
  },
];

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const wanted = ONLY.length ? SHOTS.filter(s => ONLY.includes(s.id)) : SHOTS;
  if (!wanted.length) {
    console.error('Nothing matched --only. Known shots: ' + SHOTS.map(s => s.id).join(', '));
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: !KEEP_OPEN });
  const results = [];

  for (const shot of wanted) {
    const ctx = await browser.newContext({
      ...shot.viewport,
      userAgent: shot.isMobile
        ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'
        : undefined,
      colorScheme: 'dark',
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    page.on('pageerror', () => {});
    const file = join(OUT, shot.id + '.png');
    try {
      log(`· ${shot.id} …`);
      const target = await shot.run(page);
      if (target) await target.screenshot({ path: file, animations: 'disabled' });
      else await page.screenshot({ path: file, animations: 'disabled' });
      const kb = Math.round(statSync(file).size / 1024);
      log(`  ✓ ${shot.id}.png  ${kb} KB`);
      results.push({ id: shot.id, ok: true, kb });
    } catch (err) {
      log(`  ✗ ${shot.id}: ${err.message.split('\n')[0]}`);
      results.push({ id: shot.id, ok: false, err: err.message.split('\n')[0] });
    }
    if (!KEEP_OPEN) await ctx.close();
  }

  if (!KEEP_OPEN) await browser.close();

  const ok = results.filter(r => r.ok).length;
  log(`\n${ok}/${results.length} captured into public/images/help/`);
  const bad = results.filter(r => !r.ok);
  if (bad.length) {
    log('failed: ' + bad.map(b => b.id).join(', '));
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
