#!/usr/bin/env node
// Notify search engines that Suffering Jukebox URLs changed (IndexNow + sitemap ping).
// Pulls every <loc> from the live sitemap so artist, playlist and chart pages
// are submitted — not only the handful of static URLs.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY = "7f3a9c2e1b844d6f9a0e5c1b8d2f4a6e";
const HOST = "www.sufferingjukebox.stream";
const BASE = `https://${HOST}`;
const SITEMAP = `${BASE}/sitemap.xml`;
// IndexNow accepts up to 10,000 URLs per request.
const CHUNK = 10000;

async function loadSitemapUrls() {
  const res = await fetch(SITEMAP);
  if (!res.ok) throw new Error(`sitemap ${res.status}`);
  const xml = await res.text();
  const urls = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const u = m[1].trim();
    if (u.startsWith(BASE)) urls.push(u);
  }
  if (!urls.includes(SITEMAP)) urls.push(SITEMAP);
  return [...new Set(urls)];
}

async function submitIndexNow(urls) {
  for (let i = 0; i < urls.length; i += CHUNK) {
    const chunk = urls.slice(i, i + CHUNK);
    const body = {
      host: HOST,
      key: KEY,
      keyLocation: `${BASE}/${KEY}.txt`,
      urlList: chunk,
    };
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    console.log(
      `IndexNow [${i + 1}-${i + chunk.length}/${urls.length}]: ${res.status} ${text.slice(0, 200)}`
    );
  }
}

async function pingSitemaps() {
  for (const ping of [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(SITEMAP)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(SITEMAP)}`,
  ]) {
    try {
      const res = await fetch(ping);
      console.log(`Sitemap ping ${new URL(ping).host}: ${res.status}`);
    } catch (e) {
      console.log(`Sitemap ping failed: ${e.message}`);
    }
  }
}

const keyPath = join(__dirname, "..", "public", `${KEY}.txt`);
const onDisk = readFileSync(keyPath, "utf8").trim();
if (onDisk !== KEY) {
  console.error(`IndexNow key file mismatch at ${keyPath}`);
  process.exit(1);
}

const urls = await loadSitemapUrls();
console.log(`Loaded ${urls.length} sitemap URLs`);
await submitIndexNow(urls);
await pingSitemaps();
