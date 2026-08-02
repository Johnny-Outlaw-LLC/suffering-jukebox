#!/usr/bin/env node
/**
 * Change Log gate for Suffering Jukebox.
 *
 * The Change Log inside public/index.html is public-facing (account menu ->
 * Change Log). It only stays honest if it is updated in the same push as the
 * change it describes, so this script is run by the pre-push hook whenever
 * public/index.html is part of what is being pushed.
 *
 * Checks:
 *   1. SJ_CHANGELOG's newest entry is dated today.
 *   2. SJ_APP_UPDATED_FALLBACK matches that same date.
 *   3. Dates are in descending order and none are in the future.
 *
 * Escape hatch: add a "No-Changelog: <reason>" trailer line to the commit
 * message when a change is genuinely invisible to users (refactors, infra,
 * server-only work).
 *
 * Usage: node scripts/check-changelog.js [path/to/index.html | -]
 */
const fs = require('fs');
const path = require('path');

// Pass '-' to read the HTML on stdin (the hook feeds it the exact blob being
// pushed, not whatever happens to be in the working tree).
const arg = process.argv[2];
const file = arg === '-' ? '<stdin>' : arg || path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(arg === '-' ? 0 : file, 'utf8');

function fail(msg) {
  console.error('\nChange Log check FAILED\n');
  console.error(msg.trim() + '\n');
  console.error('Fix: add a dated group at the TOP of SJ_CHANGELOG in');
  console.error('     suffering-jukebox.html (then copy to public/index.html),');
  console.error('     and set SJ_APP_UPDATED_FALLBACK to the same date.');
  console.error('     Write items for users, not for engineers: what changed on');
  console.error('     screen, in plain language, no file names or commit talk.');
  console.error('\nIf this change is genuinely invisible to users, add a trailer');
  console.error('line to the commit message and push again:');
  console.error('     No-Changelog: server-only, nothing visible on screen\n');
  process.exit(1);
}

const start = html.indexOf('const SJ_CHANGELOG = [');
if (start === -1) fail('Could not find SJ_CHANGELOG in ' + file + '.');

const block = html.slice(start, start + 200000);
const dates = [...block.matchAll(/\{\s*date:\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
if (!dates.length) fail('SJ_CHANGELOG has no dated entries.');

const today = new Date();
const iso =
  today.getFullYear() +
  '-' + String(today.getMonth() + 1).padStart(2, '0') +
  '-' + String(today.getDate()).padStart(2, '0');

const sorted = [...dates].sort().reverse();
if (dates.join() !== sorted.join()) {
  fail('SJ_CHANGELOG entries are out of order. Newest date must be first.\nGot: ' + dates.slice(0, 5).join(', '));
}
if (dates[0] > iso) fail('Newest Change Log entry (' + dates[0] + ') is in the future. Today is ' + iso + '.');
if (dates[0] !== iso) {
  fail(
    'public/index.html is being pushed, but the newest Change Log entry is ' +
      dates[0] + ' and today is ' + iso + '.'
  );
}

const fb = html.match(/const SJ_APP_UPDATED_FALLBACK = '(\d{4}-\d{2}-\d{2})'/);
if (!fb) fail('Could not find SJ_APP_UPDATED_FALLBACK.');
if (fb[1] !== dates[0]) {
  fail("SJ_APP_UPDATED_FALLBACK is '" + fb[1] + "' but the newest Change Log entry is '" + dates[0] + "'. They must match.");
}

const items = block.slice(0, block.indexOf(']},') + 3).match(/'(?:[^'\\]|\\.)*'/g) || [];
console.log('Change Log OK - ' + dates[0] + ', ' + Math.max(items.length - 1, 0) + ' item(s) in the newest group.');
