// Browser smoke check for the generated guide pages. No sign-in or writes.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const out = resolve('capture/out/audience-guide-previews');
mkdirSync(out, { recursive: true });
const brands = [
  ['Suffering Jukebox', 'http://localhost:3128', ''],
  ['Listening Party', 'http://localhost:3128', '/lp/index.html'],
  ['Record Keeper', 'http://localhost:3127/record-keeper', ''],
];
async function checkTextWidth(url) {
  const constrained = await page.evaluate(() => [...document.querySelectorAll('.hero, .hero h1, .lede')]
    .filter(el => {
      const parent = el.parentElement;
      const style = getComputedStyle(parent);
      const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.abs(el.getBoundingClientRect().width - available) > 2;
    })
    .map(el => el.tagName + ' ' + el.className));
  if (constrained.length) throw new Error(`Text does not fill its column: ${url}: ${constrained.join(', ')}`);
  if (await page.locator('h1 br').count()) throw new Error(`Forced heading break: ${url}`);
}
try {
  for (const [brand, base, suffix] of brands) {
    for (const audience of ['artists', 'listeners']) {
      const url = `${base}/for-${audience}${suffix}`;
      const errors = [];
      const onError = e => errors.push(e.message);
      page.on('pageerror', onError);
      await page.setViewportSize({ width: 1400, height: 1000 });
      const response = await page.goto(url, { waitUntil: 'networkidle' });
      if (response.status() !== 200) throw new Error(`${url}: ${response.status()}`);
      if (!(await page.title()).includes(brand)) throw new Error(`Wrong brand: ${url}`);
      await checkTextWidth(url);
      await page.locator('details').evaluateAll(rows => rows.forEach(el => { el.open = true; }));
      for (const img of await page.locator('img').all()) {
        await img.scrollIntoViewIfNeeded();
        await img.evaluate(el => el.decode());
      }
      await page.locator('details').evaluateAll(rows => rows.forEach(el => { el.open = false; }));
      const summary = page.locator('summary').first();
      await summary.click();
      if (!(await page.locator('details').first().evaluate(el => el.open))) throw new Error('Accordion did not open');
      await summary.click();
      await page.evaluate(() => window.scrollTo(0, 0));
      if (brand === 'Record Keeper') await page.screenshot({ path: `${out}/record-keeper-${audience}-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await checkTextWidth(url);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Mobile overflow: ${url}`);
      if (brand === 'Record Keeper') await page.screenshot({ path: `${out}/record-keeper-${audience}-mobile.png` });
      if (errors.length) throw new Error(errors.join('\n'));
      page.off('pageerror', onError);
      console.log(`${brand} /for-${audience}: images, accordion, desktop/mobile, JavaScript OK`);
    }
  }
} finally {
  await browser.close();
}
