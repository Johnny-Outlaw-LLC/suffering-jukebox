// @suite performance-log-check
// @area Performance
// @covers scripts/check-perf-logs.mjs thresholds and issue fingerprinting
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRows, issueBody, issueTitle, LIMITS } from '../scripts/check-perf-logs.mjs';

test('production performance logs are quiet below the configured thresholds', () => {
  const result = classifyRows([
    { event: 'browser.long-task', duration_ms: LIMITS.longTaskMs - 1, path: '/' },
    { event: 'browser.event-loop-stall', duration_ms: LIMITS.eventLoopStallMs - 1, path: '/' },
    { event: 'render.updateYTQueueUI', duration_ms: LIMITS.renderMs - 1, path: '/' },
  ]);

  assert.equal(result.shouldOpen, false);
  assert.equal(result.incidents.length, 0);
});

test('repeated or severe production events open one stable issue fingerprint', () => {
  const result = classifyRows([
    { event: 'browser.long-task', duration_ms: 2200, path: '/', detail: { surface: 'lp' } },
    { event: 'browser.long-task', duration_ms: 2400, path: '/', detail: { surface: 'lp' } },
    { event: 'browser.long-task', duration_ms: 2600, path: '/', detail: { surface: 'lp' } },
  ]);

  assert.equal(result.shouldOpen, true);
  assert.equal(result.repeated[0].event, 'browser.long-task');
  assert.equal(issueTitle(result), '[automated-performance] Production regression: browser.long-task');
  assert.match(issueBody(result, 24), /browser\.long-task/);
  assert.match(issueBody(result, 24), /\(lp\)/);
});

test('browser errors are actionable even without a long duration', () => {
  const result = classifyRows([
    { event: 'browser.unhandled-rejection', duration_ms: 0, path: '/now-playing' },
  ]);

  assert.equal(result.shouldOpen, true);
  assert.equal(result.hardFailures.length, 1);
});

test('a suspended background tab is not a main-thread hang', () => {
  const result = classifyRows([
    { event: 'browser.long-task', duration_ms: 231_956_883, path: '/' },
    { event: 'browser.event-loop-stall', duration_ms: LIMITS.implausibleBlockMs + 1, path: '/' },
  ]);
  assert.equal(result.shouldOpen, false);
  assert.equal(result.suspendedTab.length, 2);
  assert.equal(result.severe.length, 0);
});

test('a genuine multi-second main-thread block is still severe', () => {
  const result = classifyRows([{ event: 'browser.long-task', duration_ms: 8000, path: '/' }]);
  assert.equal(result.shouldOpen, true);
  assert.equal(result.fingerprint, 'browser.long-task');
});

test('one slow page load on a bad connection does not open an issue', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ event: 'browser.page-load', duration_ms: i === 0 ? 146_924 : 1200, path: '/' }));
  const result = classifyRows(rows);
  assert.equal(result.shouldOpen, false);
  assert.equal(result.pageLoadCount, 20);
});

test('a sustained page-load slowdown opens an issue', () => {
  const rows = Array.from({ length: LIMITS.pageLoadMinSamples }, () => ({ event: 'browser.page-load', duration_ms: LIMITS.pageLoadMedianMs + 500, path: '/' }));
  const result = classifyRows(rows);
  assert.equal(result.shouldOpen, true);
  assert.equal(result.fingerprint, 'browser.page-load');
});

test('a single request timeout is not a regression, repeated timeouts are', () => {
  assert.equal(classifyRows([{ event: 'browser.request-timeout', duration_ms: 12000, path: '/' }]).shouldOpen, false);
  const repeated = classifyRows(Array.from({ length: LIMITS.repeatedCount }, () => ({ event: 'browser.request-timeout', duration_ms: 12000, path: '/' })));
  assert.equal(repeated.shouldOpen, true);
  assert.equal(repeated.fingerprint, 'browser.request-timeout');
});

test('browser-extension errors are ignored but this site’s own errors are not', () => {
  const external = classifyRows([
    { event: 'browser.error', path: '/', detail: { message: "TypeError: undefined is not an object (evaluating 'window.__firefox__.reader')" } },
    { event: 'browser.error', path: '/', detail: { message: "TypeError: undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')" } },
    { event: 'browser.error', path: '/', detail: { message: 'Script error.' } },
  ]);
  assert.equal(external.shouldOpen, false);
  assert.equal(external.externalErrors.length, 3);
  const own = classifyRows([{ event: 'browser.error', path: '/', detail: { message: "Uncaught ReferenceError: Cannot access 'googleUser' before initialization" } }]);
  assert.equal(own.shouldOpen, true);
  assert.equal(own.hardFailures.length, 1);
});
