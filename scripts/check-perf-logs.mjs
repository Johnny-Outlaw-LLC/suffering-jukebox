#!/usr/bin/env node
/**
 * Read production browser telemetry and turn a sustained regression into one
 * deduplicated GitHub issue. This is intentionally separate from npm test:
 * unit/stress tests stay offline, while this check needs the service-role key
 * and is run by the scheduled performance workflow.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SUPABASE_URL = 'https://ntyvtpimesfoesuykuyi.supabase.co';
const DEFAULT_REPOSITORY = 'Johnny-Outlaw-LLC/suffering-jukebox';
const LIMITS = Object.freeze({
  longTaskMs: 2000,
  eventLoopStallMs: 2000,
  renderMs: 1000,
  hardFailureCount: 1,
  repeatedCount: 3,
  // A single main-thread block or slow render this long is severe on its own.
  severeMs: 5000,
  // A "long task" or "stall" longer than this is a tab that was suspended in the
  // background (laptop lid, phone lock), not the page hanging. Observed up to 2.7 days.
  implausibleBlockMs: 60_000,
  // Page loads are network-bound, so one slow connection is not a regression.
  // Flag only a sustained slowdown: the median of enough loads above the threshold.
  pageLoadMedianMs: 5000,
  pageLoadMinSamples: 10,
});

// Errors thrown by visitors' browser extensions or cross-origin scripts we cannot
// see into. They are not this site's bugs and cannot be fixed here.
const EXTERNAL_ERROR_PATTERNS = Object.freeze([
  /__firefox__/,
  /window\.ethereum/,
  /^(Uncaught )?Script error\.?$/,
  /(chrome|moz|safari(-web)?)-extension:\/\//,
]);

function localEnv(name) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  for (const rel of ['.env.local', '../.env.local', '../env.local']) {
    try {
      const line = readFileSync(join(root, rel), 'utf8')
        .split(/\r?\n/)
        .find((l) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(l));
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    } catch {
      // Try the next local env location.
    }
  }
  return '';
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function duration(row) {
  return numeric(row.duration_ms ?? row.detail?.durationMs);
}

function surface(row) {
  return String(row.detail?.surface || 'unknown');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classifyRows(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
    event: String(row.event || 'unknown'),
    durationMs: duration(row),
    path: String(row.path || '/'),
    surface: surface(row),
    createdAt: row.created_at || null,
    detail: row.detail && typeof row.detail === 'object' ? row.detail : {},
  }));
  const isBlocking = (r) => r.event === 'browser.long-task' || r.event === 'browser.event-loop-stall';
  const suspendedTab = normalized.filter((r) => isBlocking(r) && r.durationMs > LIMITS.implausibleBlockMs);
  const plausible = normalized.filter((r) => !(isBlocking(r) && r.durationMs > LIMITS.implausibleBlockMs));

  const errors = plausible.filter((r) =>
    /^(browser\.(error|unhandled-rejection)|.*\.error)$/.test(r.event),
  );
  const isExternal = (r) => EXTERNAL_ERROR_PATTERNS.some((re) => re.test(String(r.detail.message || '')));
  const externalErrors = errors.filter(isExternal);
  const hardFailures = errors.filter((r) => !isExternal(r));

  const longTasks = plausible.filter((r) =>
    r.event === 'browser.long-task' && r.durationMs >= LIMITS.longTaskMs,
  );
  const stalls = plausible.filter((r) =>
    r.event === 'browser.event-loop-stall' && r.durationMs >= LIMITS.eventLoopStallMs,
  );
  const slowRenders = plausible.filter((r) =>
    r.event.startsWith('render.') && r.durationMs >= LIMITS.renderMs,
  );
  const timeouts = plausible.filter((r) => r.event === 'browser.request-timeout');
  const pageLoads = plausible.filter((r) => r.event === 'browser.page-load' && r.durationMs > 0);
  const pageLoadMedianMs = median(pageLoads.map((r) => r.durationMs));
  const slowPageLoads = pageLoads.length >= LIMITS.pageLoadMinSamples
    && pageLoadMedianMs >= LIMITS.pageLoadMedianMs;

  // Severity is about the page itself blocking, not about network waits.
  const severe = [...longTasks, ...stalls, ...slowRenders].filter((r) => r.durationMs >= LIMITS.severeMs);
  const counts = new Map();
  for (const row of [...longTasks, ...stalls, ...slowRenders, ...timeouts]) {
    counts.set(row.event, (counts.get(row.event) || 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= LIMITS.repeatedCount)
    .map(([event, count]) => ({ event, count }));
  const repeatedTimeouts = repeated.some((r) => r.event === 'browser.request-timeout') ? timeouts : [];
  const incidents = [
    ...hardFailures, ...longTasks, ...stalls, ...slowRenders, ...repeatedTimeouts,
    ...(slowPageLoads ? pageLoads.filter((r) => r.durationMs >= LIMITS.pageLoadMedianMs) : []),
  ];
  const maxDurationMs = plausible.reduce((max, row) => Math.max(max, row.durationMs), 0);
  const shouldOpen = hardFailures.length >= LIMITS.hardFailureCount
    || repeated.length > 0
    || severe.length > 0
    || slowPageLoads;
  const families = [...new Set(incidents.map((r) => r.event))].sort();
  const fingerprint = families.length ? families.join(',') : 'unknown';
  return {
    rows: normalized,
    incidents,
    hardFailures,
    externalErrors,
    suspendedTab,
    longTasks,
    stalls,
    slowRenders,
    timeouts,
    pageLoadCount: pageLoads.length,
    pageLoadMedianMs,
    slowPageLoads,
    severe,
    repeated,
    maxDurationMs,
    shouldOpen,
    fingerprint,
  };
}

function isoSince(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function readProductionLogs({ baseUrl, serviceRoleKey, hours }) {
  const select = encodeURIComponent('created_at,event,duration_ms,detail,path');
  const since = encodeURIComponent(isoSince(hours));
  const url = `${baseUrl.replace(/\/$/, '')}/rest/v1/perf_events?select=${select}&created_at=gte.${since}&order=created_at.desc&limit=5000`;
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Accept-Profile': 'jukebox',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Supabase perf_events returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function reportText(result, hours) {
  const lines = [
    `Checked ${result.rows.length} performance events from the last ${hours} hour(s).`,
    `Long tasks >= ${LIMITS.longTaskMs}ms: ${result.longTasks.length}; event-loop stalls >= ${LIMITS.eventLoopStallMs}ms: ${result.stalls.length}; slow renders >= ${LIMITS.renderMs}ms: ${result.slowRenders.length}.`,
    `Maximum observed duration: ${Math.round(result.maxDurationMs)}ms (excluding ${result.suspendedTab.length} suspended-tab reading(s)).`,
    `Page loads: ${result.pageLoadCount}, median ${Math.round(result.pageLoadMedianMs)}ms; request timeouts: ${result.timeouts.length}; browser-extension errors ignored: ${result.externalErrors.length}.`,
    `Surfaces observed: ${[...new Set(result.rows.map((r) => r.surface))].sort().join(', ') || 'unknown'}.`,
  ];
  if (result.repeated.length) lines.push(`Repeated families: ${result.repeated.map((r) => `${r.event} (${r.count})`).join(', ')}.`);
  if (result.hardFailures.length) lines.push(`Hard failures: ${result.hardFailures.map((r) => r.event).join(', ')}.`);
  if (result.shouldOpen) lines.push(`Regression fingerprint: ${result.fingerprint}`);
  return lines.join('\n');
}

function issueTitle(result) {
  return `[automated-performance] Production regression: ${result.fingerprint}`;
}

function issueBody(result, hours) {
  const examples = result.incidents
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 12)
    .map((r) => `- ${r.event}: ${Math.round(r.durationMs)}ms on ${r.path} (${r.surface})`)
    .join('\n');
  return [
    '## Automated performance regression',
    '',
    `The scheduled performance check found actionable production telemetry in the last ${hours} hour(s).`,
    '',
    '```text',
    reportText(result, hours),
    '```',
    '',
    'Largest events:',
    examples || '- No individual event details available.',
    '',
    'This issue is deduplicated by its exact title. It was created by `scripts/check-perf-logs.mjs`.',
  ].join('\n');
}

async function githubRequest(token, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function raiseIssue(result, hours) {
  const token = localEnv('GITHUB_TOKEN') || localEnv('GH_TOKEN');
  if (!token) {
    console.warn('Regression found, but GITHUB_TOKEN is not configured; no issue was opened.');
    return null;
  }
  const repository = localEnv('GITHUB_REPOSITORY') || DEFAULT_REPOSITORY;
  const api = `https://api.github.com/repos/${repository}`;
  const title = issueTitle(result);
  const open = await githubRequest(token, 'GET', `${api}/issues?state=open&per_page=100`);
  const existing = open.find((item) => !item.pull_request && item.title === title);
  if (existing) {
    console.log(`existing performance issue: ${existing.html_url}`);
    return existing;
  }
  const created = await githubRequest(token, 'POST', `${api}/issues`, {
    title,
    body: issueBody(result, hours),
  });
  console.log(`opened performance issue: ${created.html_url}`);
  return created;
}

export { EXTERNAL_ERROR_PATTERNS, LIMITS, classifyRows, issueBody, issueTitle, reportText };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hours = Math.max(1, Number(process.env.PERF_WINDOW_HOURS || 24));
  const key = localEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is required to check production performance logs.');
    process.exitCode = 2;
  } else {
    try {
      const rows = await readProductionLogs({
        baseUrl: localEnv('SUPABASE_URL') || DEFAULT_SUPABASE_URL,
        serviceRoleKey: key,
        hours,
      });
      const result = classifyRows(rows);
      console.log(reportText(result, hours));
      if (result.shouldOpen && process.env.PERF_OPEN_ISSUES === 'true') {
        await raiseIssue(result, hours);
      }
      if (result.shouldOpen && process.env.PERF_FAIL_ON_REGRESSION !== 'false') process.exitCode = 1;
    } catch (error) {
      console.error(`performance log check failed: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
