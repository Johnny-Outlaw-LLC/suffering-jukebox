import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('async function sjEnsureUploadQuota(');
const end = html.indexOf('function taSyncQuotaLabel(', start);
assert.ok(start > 0 && end > start);

function quota({ unlocked = true, limit = 10_000, used = 0 } = {}) {
  const messages = [];
  const context = vm.createContext({
    sjEnsureBgUnlock: async () => unlocked,
    sjBgUnlock: { used, level: 'standard' },
    sjQuotaLimit: () => limit,
    sjTrackProductEvent: () => {},
    showToast: message => messages.push(message),
    fmtBytes: String,
    // Existing browsers can retain a full hour of timestamps after upgrading.
    localStorage: {
      getItem: () => JSON.stringify(Array(1000).fill(Date.now())),
      setItem: () => {},
    },
  });
  vm.runInContext(html.slice(start, end), context);
  return { context, messages };
}

test('1,000 uploads pass with remaining storage despite old hourly timestamps', async () => {
  const { context, messages } = quota();
  for (let i = 0; i < 1000; i++) {
    assert.equal(await context.sjEnsureUploadQuota(1), true, `upload ${i + 1}`);
    context.sjBgUnlock.used++;
  }
  assert.deepEqual(messages, []);
});

test('storage exhaustion still blocks the next file in a large batch', async () => {
  const { context } = quota({ limit: 227 });
  for (let i = 0; i < 227; i++) {
    assert.equal(await context.sjEnsureUploadQuota(1), true);
    context.sjBgUnlock.used++;
  }
  assert.equal(await context.sjEnsureUploadQuota(1), false);
});

test('signed-out and zero-storage accounts remain blocked', async () => {
  assert.equal(await quota({ unlocked: false }).context.sjEnsureUploadQuota(1), false);
  assert.equal(await quota({ limit: 0 }).context.sjEnsureUploadQuota(1), false);
});
