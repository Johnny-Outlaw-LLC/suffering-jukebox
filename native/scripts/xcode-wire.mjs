// Adds the native audio + CarPlay sources and the entitlements file to the
// Xcode project. `cap add ios` regenerates the project from a template, so this
// is idempotent and re-runnable rather than a one-time hand edit.
import xcode from 'xcode';
import { writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projPath = resolve(here, '..', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

// Matches the other Johnny Outlaw LLC apps; D89QH2NM22 is the Personal Team
// and cannot reach the App Store.
const TEAM_ID = process.env.SJ_TEAM_ID || '2J69KHU242';
const CARPLAY_ENTITLEMENT = process.env.SJ_CARPLAY_ENTITLEMENT === '1';

const proj = xcode.project(projPath);
proj.parseSync();
const target = proj.getFirstTarget().uuid;

// Paths are relative to the "App" group, whose own path is App/ - so these
// land at ios/App/App/Audio/... on disk.
const SOURCES = [
  'Audio/SJAudioEngine.swift',
  'Audio/SJAudioPlugin.swift',
  'Audio/SJDownloadStore.swift',
  'Audio/SJDownloader.swift',
  'CarPlay/SJCarPlaySceneDelegate.swift',
  'SJSceneDelegate.swift',
  'SJBridgeViewController.swift',
];

// Drop any stale references first so a re-run repairs rather than duplicates.
const wanted = new Set(SOURCES.map(p => basename(p)));
const fileRefs = proj.pbxFileReferenceSection();
const buildFiles = proj.pbxBuildFileSection();
for (const key of Object.keys(fileRefs)) {
  const ref = fileRefs[key];
  if (typeof ref !== 'object' || !ref.path) continue;
  if (!wanted.has(basename(String(ref.path).replace(/"/g, '')))) continue;
  for (const bkey of Object.keys(buildFiles)) {
    const bf = buildFiles[bkey];
    if (typeof bf === 'object' && bf.fileRef === key) {
      delete buildFiles[bkey];
      delete buildFiles[bkey + '_comment'];
    }
  }
  delete fileRefs[key];
  delete fileRefs[key + '_comment'];
}
// Purge them from every group's children and the sources build phase.
const groups = proj.hash.project.objects['PBXGroup'] || {};
for (const key of Object.keys(groups)) {
  const g = groups[key];
  if (typeof g !== 'object' || !Array.isArray(g.children)) continue;
  g.children = g.children.filter(c => !wanted.has(basename(String(c.comment || ''))));
}
const phases = proj.pbxSourcesBuildPhaseObj(target);
if (phases?.files) {
  phases.files = phases.files.filter(f => !wanted.has(basename(String(f.comment || '').split(' in ')[0])));
}

// The App group is identified by its path, not a name - Capacitor's template
// leaves name undefined.
const appGroup = proj.findPBXGroupKey({ path: 'App' }) || proj.findPBXGroupKey({ name: 'App' });
if (!appGroup) throw new Error('App group not found in project');

// Sweep any orphan groups a previous run may have created.
for (const key of Object.keys(groups)) {
  const g = groups[key];
  if (typeof g !== 'object') continue;
  if ((g.name === 'Audio' || g.name === 'CarPlay') && !(g.children || []).length) {
    delete groups[key];
    delete groups[key + '_comment'];
  }
}

let added = 0;
for (const rel of SOURCES) {
  proj.addSourceFile(rel, { target }, appGroup);
  added++;
}

// CODE_SIGN_ENTITLEMENTS on every configuration of the app target.
const configs = proj.pbxXCBuildConfigurationSection();
let signed = 0;
for (const key of Object.keys(configs)) {
  const c = configs[key];
  if (typeof c !== 'object' || !c.buildSettings) continue;
  if (String(c.buildSettings.PRODUCT_BUNDLE_IDENTIFIER || '').includes('sufferingjukebox')) {
    // CarPlay's CPListItem.isEnabled and friends are iOS 15+. iOS 14 is a 2020
    // release and no current device is stuck on it.
    c.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '15.0';
    c.buildSettings.CODE_SIGN_STYLE = 'Automatic';
    c.buildSettings.DEVELOPMENT_TEAM = TEAM_ID;
    // com.apple.developer.carplay-audio has to be granted by Apple before a
    // provisioning profile can carry it - until then automatic signing cannot
    // build for a device at all. Simulator builds do not validate entitlements,
    // so CarPlay is still developable meanwhile. Opt in once Apple approves:
    //   SJ_CARPLAY_ENTITLEMENT=1 node scripts/xcode-wire.mjs
    if (CARPLAY_ENTITLEMENT) {
      c.buildSettings.CODE_SIGN_ENTITLEMENTS = '"App/App.entitlements"';
    } else {
      delete c.buildSettings.CODE_SIGN_ENTITLEMENTS;
    }
    signed++;
  }
}

writeFileSync(projPath, proj.writeSync());
console.log(`sources added: ${added}; configs given entitlements: ${signed}`);
