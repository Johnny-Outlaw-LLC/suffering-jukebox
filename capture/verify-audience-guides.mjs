// Public guide/demo smoke checks. No credentials or writes to the real catalog.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const live = process.argv.includes('--live');
const baseDemo = live ? 'https://listeningparty.stream' : 'http://localhost:3128';
const brands = live ? [
  ['Suffering Jukebox', 'https://www.sufferingjukebox.stream', ''],
  ['Listening Party', 'https://listeningparty.stream', ''],
  ['Record Keeper', 'https://www.outlawapps.online/record-keeper', ''],
] : [
  ['Suffering Jukebox', 'http://localhost:3128', ''],
  ['Listening Party', 'http://localhost:3128', '/lp/index.html'],
  ['Record Keeper', 'http://localhost:3127/record-keeper', ''],
];
// Route-fulfilled localhost HTML has no network address in Chromium. Allow the
// local-only cross-port iframe fixture; production verification uses defaults.
const browser = await chromium.launch({ headless: true, args: live ? [] : ['--disable-features=LocalNetworkAccessChecks'] });
const context = await browser.newContext({ timezoneId: 'America/Chicago' });
const page = await context.newPage();
const errors = [], privateRequests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (/\/api\/|supabase\.co/.test(r.url())) privateRequests.push(r.url()); });
if (!live) await page.route('http://localhost:3127/record-keeper/for-*', async route => {
  const response = await route.fetch();
  await route.fulfill({ response, body: (await response.text()).replaceAll('https://listeningparty.stream/demo/', `${baseDemo}/demo/`) });
});
const out = resolve('capture/out/audience-guide-previews');
mkdirSync(out, { recursive: true });
async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(description);
    await page.waitForTimeout(100);
  }
}
async function widthCheck(target, selector = '.hero, .hero h1, .lede') {
  await until(() => target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow after resize: ${target.url()}`);
  const constrained = await target.locator(selector).evaluateAll(elements => elements.filter(el => {
    const parent = el.parentElement, style = getComputedStyle(parent);
    const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.abs(el.getBoundingClientRect().width - available) > 2;
  }).map(el => el.tagName + ' ' + el.className));
  if (constrained.length) throw new Error(`Constrained text: ${constrained}`);
  if (await target.locator('h1 br').count()) throw new Error('Forced heading break');
  const overflow = await target.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, url: location.href,
    elements: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className })) }));
  if (overflow.scroll > overflow.width + 1) throw new Error(`Horizontal document overflow: ${JSON.stringify(overflow)}`);
}
async function ready(target) {
  await target.getByRole('heading', { level: 1 }).first().waitFor();
  await target.getByText('Preparing the demo…', { exact: true }).waitFor({ state: 'hidden' });
  await target.getByText('Interactive demo · fictional content', { exact: true }).waitFor();
}
async function checkEmbed(locator) {
  await locator.evaluate(el => { for (let parent = el.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
  await locator.scrollIntoViewIfNeeded();
  const frame = await (await locator.elementHandle()).contentFrame();
  await ready(frame);
  await widthCheck(frame, 'header h1, header p');
  let sizes;
  await until(async () => {
    const mainHeight = await frame.locator('main').evaluate(el => el.getBoundingClientRect().height);
    const outerHeight = await locator.evaluate(el => el.clientHeight);
    sizes = { url: frame.url(), mainHeight, outerHeight };
    return outerHeight >= mainHeight - 2;
  }, 'Demo did not resize to its content').catch(error => { throw new Error(`${error.message}: ${JSON.stringify(sizes)}`); });
  const text = await frame.locator('body').innerText();
  if (/Nouns Group|Silver Jews|All My Daughters/.test(text)) throw new Error('Real artist data in demo');
  return frame;
}
try {
  for (const [brand, base, suffix] of brands) for (const audience of ['artists', 'listeners']) {
    const url = `${base}/for-${audience}${suffix}`;
    await page.setViewportSize({ width: 1400, height: 1000 });
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (response.status() !== 200 || !(await page.title()).includes(brand)) throw new Error(`Guide failed: ${url}`);
    await widthCheck(page);
    await page.locator('details').evaluateAll(rows => rows.forEach(el => { el.open = true; }));
    for (const image of await page.locator('img').all()) {
      await image.scrollIntoViewIfNeeded(); await image.evaluate(el => el.decode());
    }
    for (const iframe of await page.locator('iframe[data-demo]').all()) await checkEmbed(iframe);
    await page.locator('details').evaluateAll(rows => rows.forEach(el => { el.open = false; }));
    await page.locator('summary').first().click();
    if (!(await page.locator('details').first().evaluate(el => el.open))) throw new Error('Accordion failed');
    await page.locator('summary').first().click();
    await page.setViewportSize({ width: 390, height: 844 });
    await widthCheck(page);
    for (const iframe of await page.locator('iframe[data-demo]').all()) await checkEmbed(iframe);
    if (brand === 'Record Keeper') {
      const dashboard = page.locator(`iframe[src*="${audience === 'artists' ? 'artist-stats' : 'analytics'}"]`).first();
      await dashboard.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/record-keeper-${audience}-demo-mobile.png` });
      await page.setViewportSize({ width: 1400, height: 1000 });
      await checkEmbed(dashboard); await dashboard.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/record-keeper-${audience}-demo-desktop.png` });
    }
    console.log(`${brand} /for-${audience}: fictional embeds, resize, full-width text, desktop/mobile OK`);
  }
  await page.setViewportSize({ width: 1400, height: 1000 });
  const demo = async view => { await page.goto(`${baseDemo}/demo/${view}?brand=rk`, { waitUntil: 'networkidle' }); await ready(page); };
  await demo('artist-stats');
  const artistTotal = page.locator('[class*="tileValue"]').first();
  const before = await artistTotal.textContent();
  await page.getByRole('button', { name: '7 days', exact: true }).click();
  await until(async () => (await artistTotal.textContent()) !== before, 'Date filter did not update plays');
  await page.getByRole('button', { name: '1 year', exact: true }).click();
  await widthCheck(page, 'header h1, header p');
  await demo('analytics');
  await page.getByRole('button', { name: 'YouTube Takeout', exact: true }).click();
  await page.getByText('no duration in Takeout', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Spotify', exact: true }).click();
  await page.getByRole('button', { name: '90 days', exact: true }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Add to Jukebox', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Find matches', exact: true }).click();
  await dialog.getByRole('button', { name: 'Check the matches', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add 1 songs to demo', exact: true }).click();
  await until(async () => (await dialog.getByRole('status').textContent()).includes('Added 1 song'), 'Demo song was not added');
  await dialog.getByRole('button', { name: 'Return to stats' }).click();
  assert.equal(await dialog.count(), 0);
  await demo('catalog');
  await page.getByRole('button', { name: 'Add to playlist', exact: true }).first().click();
  assert.match(await page.getByRole('status').textContent(), /3 songs/);
  await demo('lyrics');
  await page.getByRole('button', { name: 'Split by song' }).click();
  assert.match(await page.getByRole('status').textContent(), /First Light/);
  await page.getByRole('slider').fill('25');
  assert.match(await page.locator('[class*="lyricActive"]').textContent(), /Every window/);
  await demo('history');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByRole('button', { name: 'Find matches', exact: true }).click();
  await page.getByRole('button', { name: 'Check the matches', exact: true }).click();
  await page.getByRole('button', { name: 'Add 6 songs to demo', exact: true }).click();
  assert.match(await page.getByRole('status').textContent(), /Added 6 songs/);
  for (const view of ['artist-stats', 'analytics', 'catalog', 'lyrics', 'history']) {
    await demo(view); await page.setViewportSize({ width: 390, height: 844 });
    await widthCheck(page, 'header h1, header p');
    await page.setViewportSize({ width: 1400, height: 1000 });
  }
  // Keep an open demo overnight: fixtures and listener date filters roll over.
  await page.clock.install({ time: new Date('2027-01-01T23:59:30-06:00') });
  await demo('analytics');
  await until(async () => (await page.locator('[class*="heroTitle"]').textContent()).includes('01/01/2027'), 'Initial demo date incorrect');
  await page.clock.runFor(61000);
  await until(async () => (await page.locator('[class*="heroTitle"]').textContent()).includes('01/02/2027'), 'Demo did not roll over at midnight');
  await demo('artist-stats');
  assert.match(await page.locator('body').innerText(), /Through Jan 2, 2027/);
  const protect = await context.request.get(`${baseDemo}/analytics`);
  if (protect.headers()['x-frame-options'] !== 'SAMEORIGIN') throw new Error('Private dashboard framing protection changed');
  const publicDemo = await context.request.get(`${baseDemo}/demo/artist-stats`);
  if (!publicDemo.headers()['content-security-policy']?.includes('https://www.outlawapps.online') || publicDemo.headers()['x-frame-options']) throw new Error('Demo embed headers incorrect');
  if (errors.length || privateRequests.length) throw new Error(JSON.stringify({ errors, privateRequests }, null, 2));
  console.log('All five interactive demos, import isolation, mobile layouts, and frame protection OK');
} finally { await browser.close(); }
