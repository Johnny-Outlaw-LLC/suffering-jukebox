/**
 * Frees the Supabase `jukebox-audio` bucket now that every upload plays from B2.
 *
 * Default is a DRY RUN: it lists the bucket, checks each object against B2 and
 * prints what it would remove. Pass --apply to delete.
 *
 *  - An object that is in B2 under the same key with the same size is removed.
 *  - An object with no B2 copy is kept, unless --include-orphans is passed AND
 *    no track_audio row points at it (an unreferenced leftover from a
 *    re-upload). A referenced object missing from B2 is never touched.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY. B2_KEY_ID / B2_APP_KEY / B2_BUCKET are read
 * from the environment, or from the share-images Render cron when RENDER_API_KEY
 * is set (Vercel holds them as sensitive, and the Bitwarden B2 key is Big Sky's).
 *
 *   python "C:\AI Projects\bitwarden-run.py" --env-file env.local -- node scripts/clear-legacy-supabase-audio.mjs [--apply] [--include-orphans]
 */
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

const SB = "https://ntyvtpimesfoesuykuyi.supabase.co";
const BUCKET = "jukebox-audio";
const RENDER_CRON = "crn-da5f8njm8hqs73cg9vj0";
const APPLY = process.argv.includes("--apply");
const ORPHANS = process.argv.includes("--include-orphans");

const SR = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SR) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
const sbHeaders = { apikey: SR, Authorization: `Bearer ${SR}`, "Content-Type": "application/json" };

async function b2Env() {
  if (process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET) return process.env;
  if (!process.env.RENDER_API_KEY) throw new Error("B2_* not set and no RENDER_API_KEY to fetch them.");
  const r = await fetch(`https://api.render.com/v1/services/${RENDER_CRON}/env-vars?limit=100`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Render env-vars ${r.status}`);
  const env = {};
  for (const row of await r.json()) { const { key, value } = row.envVar || row; env[key] = value; }
  return env;
}

async function b2Client(env) {
  const basic = Buffer.from(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`).toString("base64");
  const r = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", { headers: { Authorization: `Basic ${basic}` } });
  const body = await r.json();
  const endpoint = body?.apiInfo?.storageApi?.s3ApiUrl;
  if (!r.ok || !endpoint) throw new Error(body?.message || "Could not authorize B2.");
  const region = new URL(endpoint).hostname.match(/^s3\.([^.]+)\.backblazeb2\.com$/i)[1];
  return new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY } });
}

async function listAll(prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SB}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: sbHeaders,
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!r.ok) throw new Error(`list ${prefix}: ${r.status}`);
    const page = await r.json();
    for (const item of page) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) out.push(...await listAll(path));          // folder
      else out.push({ path, size: Number(item.metadata?.size || 0) });
    }
    if (page.length < 1000) return out;
  }
}

async function b2Size(s3, bucket, key) {
  try { return Number((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength); }
  catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null; throw e; }
}

const env = await b2Env();
const s3 = await b2Client(env);
const objects = await listAll();
const refRes = await fetch(`${SB}/rest/v1/track_audio?select=storage_path&limit=10000`, {
  headers: { ...sbHeaders, "Accept-Profile": "jukebox" },
});
if (!refRes.ok) throw new Error(`track_audio ${refRes.status}`);
const referenced = new Set((await refRes.json()).map((r) => r.storage_path));

const remove = [], keep = [];
let inB2 = 0, orphans = 0, bytes = 0;
for (const o of objects) {
  const size = await b2Size(s3, env.B2_BUCKET, o.path);
  if (size !== null && size === o.size) { remove.push(o.path); inB2++; bytes += o.size; continue; }
  if (size === null && ORPHANS && !referenced.has(o.path)) { remove.push(o.path); orphans++; bytes += o.size; continue; }
  keep.push(`${o.path} (b2=${size ?? "missing"}, supabase=${o.size}, referenced=${referenced.has(o.path)})`);
}

console.log(`${objects.length} objects in ${BUCKET}`);
console.log(`remove: ${remove.length} (${inB2} verified in B2, ${orphans} unreferenced orphans), ${(bytes / 1048576).toFixed(0)} MB`);
console.log(`keep:   ${keep.length}`);
for (const k of keep) console.log(`  keep ${k}`);

if (!APPLY) { console.log("\nDry run. Re-run with --apply to delete."); process.exit(0); }
for (let i = 0; i < remove.length; i += 100) {
  const r = await fetch(`${SB}/storage/v1/object/${BUCKET}`, {
    method: "DELETE", headers: sbHeaders, body: JSON.stringify({ prefixes: remove.slice(i, i + 100) }),
  });
  if (!r.ok) throw new Error(`delete batch ${i}: ${r.status} ${await r.text()}`);
  console.log(`deleted ${Math.min(i + 100, remove.length)}/${remove.length}`);
}
console.log("done");
