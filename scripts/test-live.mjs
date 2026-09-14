#!/usr/bin/env node
/**
 * npm run test:live - the checks that sign the shared smoke-test account in.
 *
 * Kept apart from `npm test` (scripts/run-tests.mjs) on purpose: that suite runs
 * offline and on every Vercel build, and it writes the committed
 * test-results.json. These talk to Supabase and the live site. See
 * tests/live/test-account.live.mjs.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tests', 'live');
const files = readdirSync(dir).filter((f) => f.endsWith('.live.mjs')).sort().map((f) => join(dir, f));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root, env: process.env });
process.exit(result.status ?? 1);
