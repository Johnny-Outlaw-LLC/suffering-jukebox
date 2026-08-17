import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";
const BUCKET = "jukebox-audio";
const CONCURRENCY = 3;

for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET"]) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required.`);
}

async function b2Client() {
  const basic = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString("base64");
  const response = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` },
  });
  const body = await response.json();
  const endpoint = body?.apiInfo?.storageApi?.s3ApiUrl;
  if (!response.ok || !endpoint) throw new Error(body?.message || "Could not authorize Backblaze B2.");
  const region = new URL(endpoint).hostname.match(/^s3\.([^.]+)\.backblazeb2\.com$/i)?.[1];
  if (!region) throw new Error("Could not determine the Backblaze B2 region.");
  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APP_KEY },
  });
}

async function existingSize(s3, key) {
  try {
    const found = await s3.send(new HeadObjectCommand({ Bucket: process.env.B2_BUCKET, Key: key }));
    return Number(found.ContentLength);
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function runPool(items, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  }));
}

const source = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const s3 = await b2Client();
const { data: rows, error } = await source
  .schema("jukebox")
  .from("track_audio")
  .select("id,storage_path,file_bytes")
  .not("storage_path", "is", null)
  .order("id")
  .range(0, 9999);
if (error) throw error;

let copied = 0;
let skipped = 0;
let bytes = 0;
await runPool(rows || [], async (row) => {
  const expected = Number(row.file_bytes || 0);
  const present = await existingSize(s3, row.storage_path);
  if (present !== null && (!expected || present === expected)) {
    skipped += 1;
    bytes += present;
    return;
  }
  const { data: blob, error: downloadError } = await source.storage.from(BUCKET).download(row.storage_path);
  if (downloadError || !blob) throw new Error(`${row.id}: ${downloadError?.message || "could not download source"}`);
  const body = Buffer.from(await blob.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  await s3.send(new PutObjectCommand({
    Bucket: process.env.B2_BUCKET,
    Key: row.storage_path,
    Body: body,
    ContentType: blob.type || "audio/mpeg",
    Metadata: { "sj-track-audio-id": row.id, sha256 },
  }));
  const verified = await existingSize(s3, row.storage_path);
  if (verified !== body.length) throw new Error(`${row.id}: B2 verification failed (${verified} bytes)`);
  copied += 1;
  bytes += verified;
  console.log(`copied ${copied + skipped}/${rows.length}: ${row.storage_path}`);
});

console.log(JSON.stringify({
  ok: true,
  source_rows: rows?.length || 0,
  copied,
  already_present: skipped,
  verified_bytes: bytes,
  source_bucket_retained: true,
}, null, 2));
