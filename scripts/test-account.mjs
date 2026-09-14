/**
 * The shared smoke-test account.
 *
 * testing@shutterfield.com belongs to Shutterfield, on the same Supabase
 * project, so its password is Shutterfield's to set. The source of truth is
 * SHUTTERFIELD_TEST_PASSWORD on the shutterfield Vercel project, NOT a local
 * env file: local copies have gone stale before. Nothing in this repo sets or
 * resets that password (jukebox.ensure_test_account returns an existing account
 * untouched, and tests/email-sign-in.test.mjs fails if anything could change a
 * password), and nothing here prints it or anything derived from it.
 *
 * On this site the account is credited as Johnny D, so whatever the live tests
 * leave behind can stay public.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_ACCOUNT = Object.freeze({
  email: 'testing@shutterfield.com',
  publicName: 'Johnny D',
  vercelProject: 'shutterfield',
  vercelKey: 'SHUTTERFIELD_TEST_PASSWORD',
});

const VERCEL_TEAM = 'team_f57nbs5WgnSbcT3tVRv8SYPW';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** VERCEL_TOKEN from the environment, or from the shared AI Projects env.local. */
function vercelToken() {
  const fromEnv = process.env.VERCEL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  for (const rel of ['.env.local', '../.env.local', '../env.local', '../../env.local', '../../../env.local']) {
    try {
      const line = readFileSync(join(root, rel), 'utf8')
        .split(/\r?\n/)
        .find((l) => /^\s*(export\s+)?VERCEL_TOKEN\s*=/.test(l));
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * The test account's password, or null when there is no way to reach it.
 * SJ_TEST_PASSWORD wins when set (a CI secret, say); otherwise it is read from
 * Vercel. /v9/projects/<p>/env?decrypt=true answers 200 with the ENCRYPTED
 * value, so the list call only finds the variable's id and the per-variable
 * endpoint returns the real value.
 */
export async function testAccountPassword() {
  const fromEnv = process.env.SJ_TEST_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  const token = vercelToken();
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  const base = `https://api.vercel.com`;
  const listRes = await fetch(`${base}/v9/projects/${TEST_ACCOUNT.vercelProject}/env?teamId=${VERCEL_TEAM}`, { headers });
  if (!listRes.ok) return null;
  const list = await listRes.json();
  const entry = (list.envs || []).find((e) => e.key === TEST_ACCOUNT.vercelKey);
  if (!entry?.id) return null;
  const oneRes = await fetch(`${base}/v1/projects/${TEST_ACCOUNT.vercelProject}/env/${entry.id}?teamId=${VERCEL_TEAM}`, { headers });
  if (!oneRes.ok) return null;
  const one = await oneRes.json();
  return typeof one.value === 'string' && one.value.trim() ? one.value.trim() : null;
}
