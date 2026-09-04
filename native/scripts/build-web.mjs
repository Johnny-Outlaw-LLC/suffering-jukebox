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

// Marker must be distinct from the app's own reads of window.__SJ_NATIVE__ -
// the web source references that name, so testing for the bare name matched
// the app's own code and silently skipped the injection, leaving the shell
// running in web mode.
const MARKER = 'sj-native-flag';
const FLAG = `<script id="${MARKER}">window.__SJ_NATIVE__ = true;</script>`;
if (!html.includes(`id="${MARKER}"`)) {
  html = html.replace('<head>', `<head>\n${FLAG}`);
  if (!html.includes(`id="${MARKER}"`)) {
    throw new Error('could not inject native flag: no <head> found');
  }
}
await writeFile(indexPath, html);

console.log(`staged ${web} -> ${www}`);
