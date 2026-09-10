// @suite Change Log integrity
// @area Change Log
// @covers SJ_CHANGELOG and SJ_APP_UPDATED_FALLBACK in public/index.html
//
// The Change Log is public facing (account menu -> Change Log) and the account
// menu also prints "App last updated" from SJ_APP_UPDATED_FALLBACK. A push hook
// already refuses a push whose newest entry is not dated today; that is a rule
// about the push. These are rules about the DATA, and they hold at any moment:
// the two dates agree, the list runs newest first, nothing is dated in the
// future, and no entry is empty or written for engineers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml, htmlSlice } from './_load.mjs';

const fallback = dashboardHtml.match(/const SJ_APP_UPDATED_FALLBACK\s*=\s*'([\d-]+)'/);

/** Every `date: 'YYYY-MM-DD'` in the SJ_CHANGELOG literal, in source order. */
const body = htmlSlice('const SJ_CHANGELOG = [', '\n];');
const dates = [...body.matchAll(/\{\s*date:\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);

test('the account menu has a date to print and the Change Log has entries', () => {
  assert.ok(fallback, 'SJ_APP_UPDATED_FALLBACK is missing or no longer a plain date string');
  assert.ok(dates.length > 0, 'SJ_CHANGELOG has no dated entries');
});

test('App last updated is the date of the newest entry, not a date of its own', () => {
  assert.equal(
    fallback[1],
    dates[0],
    'SJ_APP_UPDATED_FALLBACK and the newest Change Log entry disagree',
  );
});

test('the Change Log runs newest first', () => {
  const sorted = [...dates].sort().reverse();
  assert.deepStrictEqual(dates, sorted, 'an entry is out of order');
});

test('everything shipped on one day is one entry', () => {
  assert.equal(new Set(dates).size, dates.length, 'two entries carry the same date');
});

test('nothing is dated in the future', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(dates[0] <= today, 'the newest entry is dated ' + dates[0] + ', which is after today');
});

test('every entry has at least one item, and no item is a commit subject', () => {
  const groups = body.split(/\{\s*date:\s*'\d{4}-\d{2}-\d{2}',\s*items:\s*\[/).slice(1);
  assert.equal(groups.length, dates.length, 'an entry is not shaped { date, items: [...] }');
  groups.forEach((group, i) => {
    const items = [...group.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    assert.ok(items.length > 0, dates[i] + ' has no items');
    for (const item of items) {
      assert.ok(item.length > 20, dates[i] + ' has an item too short to mean anything: ' + item);
      // Written for users, not for engineers: no file names, no refactor talk.
      assert.doesNotMatch(
        item,
        /\brefactor(ed|ing|s)?\b|\b[\w-]+\.(ts|tsx|mjs|jsx|sql)\b|\bsrc\/[a-z]/i,
        dates[i] + ' has an item written for engineers: ' + item,
      );
    }
  });
});
