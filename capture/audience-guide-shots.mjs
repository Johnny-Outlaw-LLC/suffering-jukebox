// Capture existing dashboards and tools for the public audience guides.
// Credentials and the temporary owner session stay in memory. No email is sent.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/images/guides');
mkdirSync(out, { recursive: true });
const url = 'https://ntyvtpimesfoesuykuyi.supabase.co';
const publicSource = readFileSync(resolve(root, 'src/lib/sj-browser-auth.ts'), 'utf8');
const anon = publicSource.match(/SJ_SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)[1];
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const auth = createClient(url, anon, { auth: { persistSession: false } });
const email = 'johnnyoutlawllc@gmail.com';
const { data: users, error: usersError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (usersError || !users.users.some(u => u.email === email)) throw new Error('Existing owner account unavailable');
const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
if (linkError) throw new Error('Could not create temporary capture session');
const { data: signed, error: verifyError } = await auth.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
if (verifyError || !signed.session) throw new Error('Could not authenticate capture session');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1060 }, deviceScaleFactor: 1 });
await context.addInitScript(({ session }) => {
  localStorage.setItem('sb-ntyvtpimesfoesuykuyi-auth-token', JSON.stringify(session));
}, { session: signed.session });
const page = await context.newPage();
const base = 'https://listeningparty.stream';
const manifest = [];
async function shot(name, route, waitText, before, clip) {
  await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(waitText, { exact: false }).first().waitFor({ timeout: 45000 });
  if (before) await before();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve(out, name + '.png'), ...(clip ? { clip } : {}) });
  manifest.push({ file: name + '.png', source: base + route, captured: new Date().toISOString() });
  console.log('Captured ' + name);
}
try {
  await shot('artist-stats', '/artist-stats?artist=nouns-group&days=30', 'Plays per day', null, { x: 120, y: 150, width: 1160, height: 850 });
  await shot('listener-analytics', '/analytics', 'hours of playback history');
  await page.getByRole('button', { name: 'Import listening history', exact: true }).click();
  await page.getByText('Choose Spotify history JSON files', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, 'spotify-history.png') });
  manifest.push({ file: 'spotify-history.png', source: base + '/analytics', captured: new Date().toISOString() });
  await page.getByRole('button', { name: 'YouTube Takeout', exact: true }).click();
  await page.screenshot({ path: resolve(out, 'google-history.png') });
  manifest.push({ file: 'google-history.png', source: base + '/analytics', captured: new Date().toISOString() });
  await shot('history-to-catalog', '/analytics', 'hours of playback history', async () => {
    await page.getByRole('button', { name: 'Plays', exact: true }).click();
    await page.waitForTimeout(2500);
    const single = page.getByRole('button', { name: 'Add to Jukebox', exact: true }).first();
    const batch = page.getByRole('button', { name: /^Import \d+ missing$/ }).first();
    for (const source of ['Spotify', 'YouTube Takeout']) {
      if (await single.count() || await batch.count()) break;
      const filter = page.getByRole('button', { name: source, exact: true });
      if (await filter.count()) { await filter.click(); await page.waitForTimeout(2500); }
    }
    if (await single.count()) await single.click();
    else if (await batch.count()) await batch.click();
    else {
      await page.getByRole('heading', { name: 'Plays by artist', exact: true }).scrollIntoViewIfNeeded();
      return;
    }
    await page.getByRole('heading', { name: 'Import missing songs', exact: true }).waitFor();
  });
  await shot('artist-upload', '/artist-discography-upload', 'New release');
  await page.goto(base + '/silver-jews', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof dbGet === 'function' && typeof googleUser !== 'undefined' && googleUser);
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Albums List', exact: false }).first().click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: resolve(out, 'discography.png') });
  manifest.push({ file: 'discography.png', source: base + '/silver-jews', captured: new Date().toISOString() });
  await page.goto(base + '/nouns-group', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof dbGet === 'function' && typeof googleUser !== 'undefined' && googleUser);
  const album = await page.evaluate(async () => {
    const artists = await dbGet('/artists?slug=eq.nouns-group&select=id');
    return (await dbGet('/albums?artist_id=eq.' + artists[0].id + '&select=id,name&order=release_date.desc&limit=1'))[0];
  });
  await page.evaluate(id => openAlbumLyrics(id), album.id);
  await page.locator('#aly-ta').waitFor({ state: 'visible' });
  await page.locator('#albumLyricsOverlay > .pl-modal').screenshot({ path: resolve(out, 'album-lyrics.png') });
  manifest.push({ file: 'album-lyrics.png', source: base + '/nouns-group', captured: new Date().toISOString() });
  await page.evaluate(async () => {
    const track = _alyAlbum.tracks[0];
    alyClose();
    await lsyOpen(track.id, await lsyLyricsFor(track.id), { follow: true });
  });
  await page.locator('#lsyOverlay.open').waitFor({ state: 'visible' });
  await page.locator('#lsyOverlay > .pl-modal').screenshot({ path: resolve(out, 'lyric-sync.png') });
  manifest.push({ file: 'lyric-sync.png', source: base + '/nouns-group', captured: new Date().toISOString() });
  writeFileSync(resolve(out, 'sources.json'), JSON.stringify(manifest, null, 2));
} finally {
  await browser.close();
  await auth.auth.signOut({ scope: 'local' });
}
