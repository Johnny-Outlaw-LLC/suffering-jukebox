// @suite Never play this again
// @area Track menu
// @covers sjmBlockScope in public/index.html
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('song break menu offers Song, Album, and Artist scopes', () => {
  const from = html.indexOf('function sjmOpenBreak()');
  const to = html.indexOf('// True when this listener already holds', from);
  assert.ok(from > 0 && to > from, 'could not locate song break menu');
  const block = html.slice(from, to);
  assert.match(block, /sjm-scope-btn/);
  assert.match(block, />Song<\/button>/);
  assert.match(block, />Album<\/button>/);
  assert.match(block, />Artist<\/button>/);
  assert.match(block, /sjmBlockScope\(\)/);
  assert.match(block, /Never play ' \+ label \+ ' again/);
});

test('album and artist Never Play actions resolve and block every scoped song', () => {
  const from = html.indexOf('async function sjmBlockScope()');
  const to = html.indexOf('function sjmClearBreak()', from);
  assert.ok(from > 0 && to > from, 'could not locate scoped Never Play action');
  const block = html.slice(from, to);
  assert.match(block, /sjmBreakScopeTrackIds\(tid, scope\)/);
  assert.match(block, /blockedTracks\[id\] = true/);
  assert.match(block, /dbPost\('\/blocked_tracks'/);
});
