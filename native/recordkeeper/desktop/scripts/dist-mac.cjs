'use strict';
// npm run dist:mac — the Mac download, ready to hand to a stranger.
//
// 1. Preflight: the Developer ID certificate is in the keychain and the
//    notarytool keychain profile works. Both are instant to check, and
//    finding either missing after the package step wastes the whole build.
// 2. electron-builder packages a universal app, signs it under the hardened
//    runtime and, because APPLE_KEYCHAIN_PROFILE is set, notarizes and staples
//    it. The stapled ticket is what lets the copy in /Applications verify
//    with no network.
// 3. The dmg around it is signed, notarized and stapled too, which is what
//    Gatekeeper checks the moment the download is opened.
//
// Credentials are never read here: notarytool reads its keychain profile
// itself. Store one once, interactively (it asks for an app-specific password
// from https://account.apple.com):
//
//   xcrun notarytool store-credentials "shutterfield-notary" \
//     --apple-id "johnnyoutlawllc@gmail.com" --team-id 2J69KHU242
//
// The profile is per Apple ID, not per app, so Shutterfield's serves here.
// RK_NOTARY_PROFILE names a different one. RK_SKIP_NOTARIZE=1 signs without
// notarizing, for testing a packaging change; that dmg warns on every other
// Mac and must not be published.

const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEAM_ID = '2J69KHU242';
const IDENTITY = `Developer ID Application: Johnny Outlaw LLC (${TEAM_ID})`;
const PROFILE = process.env.RK_NOTARY_PROFILE || 'shutterfield-notary';
const SKIP = process.env.RK_SKIP_NOTARIZE === '1';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
}

function preflight() {
  if (process.platform !== 'darwin') throw new Error('The Mac build has to run on a Mac.');
  const ids = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!ids.includes(IDENTITY)) {
    throw new Error(`Signing certificate not in the keychain: ${IDENTITY}\n`
      + '  Create it at https://developer.apple.com/account/resources/certificates (Developer ID Application, team 2J69KHU242).');
  }
  console.log(`✓ ${IDENTITY}`);
  if (SKIP) { console.warn('⚠ RK_SKIP_NOTARIZE=1: signing only. Do not publish this dmg.'); return; }
  // history is the cheapest authenticated call (and takes no --limit).
  const probe = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', PROFILE, '--output-format', 'json'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`notarytool profile "${PROFILE}" does not work:\n  ${(probe.stderr || probe.stdout).trim().split('\n')[0]}\n`
      + `  Store it once: xcrun notarytool store-credentials "${PROFILE}" --apple-id "johnnyoutlawllc@gmail.com" --team-id ${TEAM_ID}`);
  }
  console.log(`✓ notarytool profile "${PROFILE}"`);
}

function notarize(target) {
  console.log(`\n→ Notarizing ${path.basename(target)} (usually 1-5 minutes)…`);
  const r = spawnSync('xcrun', ['notarytool', 'submit', target, '--keychain-profile', PROFILE,
    '--wait', '--timeout', '30m', '--output-format', 'json'], { encoding: 'utf8' });
  let verdict = {};
  try { verdict = JSON.parse(r.stdout); } catch { throw new Error(`notarytool said: ${r.stdout || r.stderr}`); }
  // submit --wait exits 0 on an Invalid verdict too, so the status decides.
  if (verdict.status !== 'Accepted') {
    if (verdict.id) spawnSync('xcrun', ['notarytool', 'log', verdict.id, '--keychain-profile', PROFILE], { stdio: 'inherit' });
    throw new Error(`Apple did not accept ${path.basename(target)}: ${verdict.status || 'no status'}`);
  }
  console.log(`✓ Accepted (${verdict.id})`);
  run('xcrun', ['stapler', 'staple', target]);
}

function assess(target, type) {
  const args = type === 'open'
    ? ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', target]
    : ['--assess', '--type', 'execute', '-vv', target];
  const r = spawnSync('spctl', args, { encoding: 'utf8' });
  console.log(`${r.stdout || ''}${r.stderr || ''}`.trim());
  if (r.status !== 0 && !SKIP) throw new Error(`Gatekeeper rejects ${path.basename(target)}; a downloader would see a warning.`);
}

function main() {
  preflight();
  const version = require(path.join(ROOT, 'package.json')).version;
  const env = { ...process.env, CSC_NAME: `Johnny Outlaw LLC (${TEAM_ID})` };
  if (SKIP) delete env.APPLE_KEYCHAIN_PROFILE;
  else env.APPLE_KEYCHAIN_PROFILE = PROFILE;
  run(path.join(ROOT, 'node_modules', '.bin', 'electron-builder'), ['--mac', 'dmg', '--universal', '--publish', 'never'], { env });

  const app = path.join(ROOT, 'dist', 'mac-universal', 'Record Keeper.app');
  const dmg = path.join(ROOT, 'dist', `Record-Keeper-${version}.dmg`);
  for (const f of [app, dmg]) if (!fs.existsSync(f)) throw new Error(`Expected ${f}`);

  console.log('\n→ Gatekeeper on the app:');
  assess(app, 'execute');

  // electron-builder leaves the dmg itself unsigned. Sign before notarizing:
  // signing afterwards would break the stapled ticket.
  run('codesign', ['--force', '--sign', IDENTITY, '--timestamp', dmg]);
  if (!SKIP) notarize(dmg);
  console.log('\n→ Gatekeeper on the dmg:');
  assess(dmg, 'open');
  console.log(`\n✓ ${path.relative(ROOT, dmg)}`);
}

try { main(); } catch (e) { console.error(`\n✗ ${e.message}`); process.exit(1); }
