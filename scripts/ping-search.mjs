#!/usr/bin/env node
// Notify search engines that Suffering Jukebox URLs changed (IndexNow + sitemap ping).
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY = "7f3a9c2e1b844d6f9a0e5c1b8d2f4a6e";
const HOST = "www.sufferingjukebox.stream";
const BASE = `https://${HOST}`;

const urls = [
  `${BASE}/`,
  `${BASE}/about`,
  `${BASE}/help`,
  `${BASE}/share`,
  `${BASE}/silver-jews`,
  `${BASE}/purple-mountains`,
  `${BASE}/llms.txt`,
  `${BASE}/sitemap.xml`,
];

async function indexNow() {
  const body = {
    host: HOST,
    key: KEY,
    keyLocation: `${BASE}/${KEY}.txt`,
    urlList: urls,
  };
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  console.log(`IndexNow: ${res.status} ${text.slice(0, 200)}`);
}

async function pingSitemaps() {
  const sitemap = `${BASE}/sitemap.xml`;
  for (const ping of [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemap)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemap)}`,
  ]) {
    try {
      const res = await fetch(ping);
      console.log(`Sitemap ping ${new URL(ping).host}: ${res.status}`);
    } catch (e) {
      console.log(`Sitemap ping failed: ${e.message}`);
    }
  }
}

// Sanity: key file exists in public/
const keyPath = join(__dirname, "..", "public", `${KEY}.txt`);
const onDisk = readFileSync(keyPath, "utf8").trim();
if (onDisk !== KEY) {
  console.error(`IndexNow key file mismatch at ${keyPath}`);
  process.exit(1);
}

await indexNow();
await pingSitemaps();
