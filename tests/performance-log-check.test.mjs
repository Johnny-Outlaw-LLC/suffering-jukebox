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
