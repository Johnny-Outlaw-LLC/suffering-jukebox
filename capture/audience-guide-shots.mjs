// Optional preview captures of the public fictional demos. No credentials,
// owner session, live artist data, or listening-history records are accessed.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const base = process.argv[2] || 'http://localhost:3128';
const out = resolve('capture/out/demo-previews');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
try {
  for (const view of ['artist-stats', 'analytics', 'catalog', 'lyrics', 'history']) {
    await page.goto(`${base}/demo/${view}?brand=rk`, { waitUntil: 'networkidle' });
    await page.getByText('Preparing the demo…', { exact: true }).waitFor({ state: 'hidden' });
    await page.screenshot({ path: `${out}/${view}.png` });
    console.log('Captured fictional demo ' + view);
  }
} finally { await browser.close(); }
