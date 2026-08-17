import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

for (const name of ["B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET"]) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required.`);
}

async function client() {
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

const cors = {
  CORSRules: [{
    ID: "suffering-jukebox-private-audio",
    AllowedOrigins: [
      "https://sufferingjukebox.stream",
      "https://www.sufferingjukebox.stream",
      "http://localhost:3000",
    ],
    AllowedMethods: ["GET", "PUT", "HEAD"],
    AllowedHeaders: ["content-type", "range", "x-amz-*"],
    ExposeHeaders: ["accept-ranges", "content-length", "content-range", "etag"],
    MaxAgeSeconds: 3600,
  }],
};

const s3 = await client();
await s3.send(new PutBucketCorsCommand({ Bucket: process.env.B2_BUCKET, CORSConfiguration: cors }));
const verified = await s3.send(new GetBucketCorsCommand({ Bucket: process.env.B2_BUCKET }));
console.log(JSON.stringify({ bucket: process.env.B2_BUCKET, cors: verified.CORSRules }, null, 2));
