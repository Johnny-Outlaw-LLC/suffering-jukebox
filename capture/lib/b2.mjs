/**
 * Backblaze B2 upload for share images.
 *
 * Uses the same private `suffering-jukebox-audio` bucket as track audio — the
 * app key is scoped to it and cannot create new buckets. Share images are made
 * public by the app's /share-image route, not by the bucket, which is what we
 * want anyway: the images live on sufferingjukebox.stream so search engines
 * attribute them to our domain.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

let clientPromise = null;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function discoverS3Endpoint() {
  const basic = Buffer.from(
    `${required("B2_KEY_ID")}:${required("B2_APP_KEY")}`
  ).toString("base64");
  const res = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` },
  });
  const body = await res.json();
  const endpoint = body?.apiInfo?.storageApi?.s3ApiUrl;
  if (!res.ok || !endpoint) throw new Error(body?.message || "Could not authorize Backblaze B2.");
  return endpoint;
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const endpoint = await discoverS3Endpoint();
      const region = new URL(endpoint).hostname.match(
        /^s3\.([^.]+)\.backblazeb2\.com$/i
      )?.[1];
      if (!region) throw new Error("Could not determine the Backblaze B2 region.");
      return new S3Client({
        endpoint,
        region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: required("B2_KEY_ID"),
          secretAccessKey: required("B2_APP_KEY"),
        },
      });
    })();
  }
  return clientPromise;
}

/** Upload (overwriting) a PNG at a stable key. Returns the key. */
export async function uploadPng(key, buffer) {
  const client = await getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: required("B2_BUCKET"),
      Key: key,
      Body: buffer,
      ContentType: "image/png",
      CacheControl: "public, max-age=3600",
    })
  );
  return key;
}
