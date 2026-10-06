// Bundle public/ with the canonical website brand settings.
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const nativeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(nativeDir, '..');
const id = process.argv[2] || process.env.SJ_NATIVE_SURFACE || 'lp';
const appDir = process.env.SJ_NATIVE_APP_DIR ? resolve(process.env.SJ_NATIVE_APP_DIR) : id === 'rk' ? resolve(nativeDir, 'recordkeeper') : nativeDir;
if (!['lp', 'rk'].includes(id)) throw new Error('Native surface must be lp or rk');
async function loadModule(path, imports = {}) {
  const js = ts.transpileModule(await readFile(resolve(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'require', 'module', js)(module.exports, name => {
    if (!(name in imports)) throw new Error('Unexpected brand dependency: ' + name);
    return imports[name];
  }, module);
  return module.exports;
}
const surfaces = await loadModule('src/lib/surface.ts');
const { applySurfaceHead } = await loadModule('src/lib/surface-head.ts', { '@/lib/surface': surfaces });
const surface = surfaces.SURFACES[id];
const web = resolve(root, 'public');
const www = resolve(appDir, 'www');
await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
await cp(web, www, { recursive: true });
await rm(resolve(www, 'og-image.png'), { force: true });
const indexPath = resolve(www, 'index.html');
let html = applySurfaceHead(await readFile(indexPath, 'utf8'), surface);
if (id === 'rk') html = html.replaceAll('Send to iPhone', 'Send to phone').replaceAll('On iPhone', 'On phone').replaceAll('Ready for CarPlay', 'Ready for the car');
html = html.replace('<head>', '<head>\n<script id="sj-native-flag">window.__SJ_NATIVE__=true;</script>');
if (!html.includes('id="sj-native-flag"')) throw new Error('Could not inject native flag');
await writeFile(indexPath, html);
console.log(`Staged ${surface.name}: ${web} -> ${www}`);
