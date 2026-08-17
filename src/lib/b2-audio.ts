import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type B2ApiInfo = {
  s3ApiUrl?: string;
};

let clientPromise: Promise<S3Client> | null = null;

function required(name: "B2_KEY_ID" | "B2_APP_KEY" | "B2_BUCKET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function discoverS3Endpoint(): Promise<string> {
  const keyId = required("B2_KEY_ID");
  const appKey = required("B2_APP_KEY");
  const basic = Buffer.from(`${keyId}:${appKey}`).toString("base64");
  const response = await fetch("https://api.backblazeb2.com/b2api/v4/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` },
    cache: "no-store",
  });
  const body = (await response.json()) as { apiInfo?: { storageApi?: B2ApiInfo }; message?: string };
  const endpoint = body.apiInfo?.storageApi?.s3ApiUrl;
  if (!response.ok || !endpoint) {
    throw new Error(body.message || "Could not authorize Backblaze B2.");
  }
  return endpoint;
}

async function getClient(): Promise<S3Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const endpoint = await discoverS3Endpoint();
      const host = new URL(endpoint).hostname;
      const region = host.match(/^s3\.([^.]+)\.backblazeb2\.com$/i)?.[1];
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

export function getB2AudioBucket(): string {
  return required("B2_BUCKET");
}

export async function createB2UploadUrl(key: string, contentType: string): Promise<string> {
  const client = await getClient();
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: getB2AudioBucket(), Key: key, ContentType: contentType }),
    { expiresIn: 10 * 60 },
  );
}

export async function createB2DownloadUrl(key: string, expiresIn = 6 * 60 * 60): Promise<string> {
  const client = await getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: getB2AudioBucket(), Key: key }),
    { expiresIn },
  );
}

export async function getB2AudioObjectSize(key: string): Promise<number> {
  const client = await getClient();
  const result = await client.send(new HeadObjectCommand({ Bucket: getB2AudioBucket(), Key: key }));
  const size = Number(result.ContentLength);
  if (!Number.isFinite(size) || size < 0) throw new Error("Backblaze B2 did not return an audio size.");
  return size;
}

export async function deleteB2AudioObject(key: string): Promise<void> {
  const client = await getClient();
  await client.send(new DeleteObjectCommand({ Bucket: getB2AudioBucket(), Key: key }));
}
