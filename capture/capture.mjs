/**
 * Suffering Jukebox — nightly share-image capture.
 *
 * Screenshots every artist jukebox in every view, composes social-ready frames,
 * uploads them to B2 at STABLE keys, and records them in jukebox.share_images.
 * Stable keys are the point: a link posted to Reddit in March keeps showing
 * current view counts, because tonight's run overwrites the same object.
 *
 * Runs as a Render cron job. Locally:
 *   node capture.mjs --dry-run --limit 1 --out ./out
 *   node capture.mjs silver-jews pavement
 *
 * NOTE: this reaches into the app's page globals (setViewMode, expandAllTracks,
 * collapseAllTracks, selectedIds, albums, tracks, isAlbumVisible). It lives in
 * this repo so renaming one of those turns up in a grep. If a shot silently
 * goes blank, check those names first.
 */
import { chromium } from "playwright";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { uploadPng } from "./lib/b2.mjs";
import { listArtists, recordShareImage, pruneMissing } from "./lib/db.mjs";

const SITE = process.env.SJ_SITE_URL || "https://www.sufferingjukebox.stream";
const KEY_PREFIX = "share/v1";
const NAV_TIMEOUT = 90000;

const VIEWPORT_BASE = { width: 1600, height: 1000 };
const REEL = { width: 1080, height: 1920 };
const OG = { width: 1200, height: 630 };

const PX_PER_ALBUM_COLLAPSED = 200;
const PX_PER_ALBUM_EXPANDED = 240;
const VIEWPORT_MIN_W = 1280;
const VIEWPORT_MAX_W = 5200;
const VIEWPORT_MIN_H = 900;
const VIEWPORT_MAX_H = 3200;

// MUST mirror SJ_EXPORT_SHOTS in public/index.html, id for id. The Export modal
// offers exactly these, and anything missing here makes the modal fall back to
// rendering in the browser, which is what this job exists to avoid.
const ALL_SHOTS = [
  { id: "byyear-collapsed", label: "By Year", view: "byyear", expand: false, ogSource: true },
  { id: "byyear-expanded", label: "By Year · Tracks Open", view: "byyear", expand: true },
  { id: "timeline-collapsed", label: "Timeline", view: "timeline", expand: false },
  { id: "timeline-expanded", label: "Timeline · Tracks Open", view: "timeline", expand: true },
  { id: "byviews-collapsed", label: "By Views", view: "byviews", expand: false },
  { id: "byviews-expanded", label: "By Views · Tracks Open", view: "byviews", expand: true },
  { id: "albumlist", label: "Albums List", view: "list", expand: true },
  { id: "alltracks", label: "All Tracks", view: "alltracks", expand: false },
];

const CAPTURE_CSS = `
  html.sj-capture, html.sj-capture body { background: #0a0a0a !important; }
  html.sj-capture #yt-player-container,
  html.sj-capture #yt-player-container *,
  html.sj-capture #ytp-mini-footer,
  html.sj-capture #ytp-mini-footer *,
  html.sj-capture .ytp-mini-footer,
  html.sj-capture .yt-player,
  html.sj-capture .yt-player-header,
  html.sj-capture .yt-player-frame,
  html.sj-capture #auth-btn,
  html.sj-capture #user-menu-wrap,
  html.sj-capture #themeToggle,
  html.sj-capture .theme-toggle,
  html.sj-capture #cookie-banner,
  html.sj-capture .toast,
  html.sj-capture #toast-host,
  html.sj-capture footer,
  html.sj-capture .footer-note,
  html.sj-capture .sc-edge,
  html.sj-capture [id*="cookie"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
    height: 0 !important;
    max-height: 0 !important;
    overflow: hidden !important;
  }
  html.sj-capture #share-btn,
  html.sj-capture button[onclick*="share"],
  html.sj-capture .search-wrap { opacity: 0.35 !important; }
`;

const HIDE_PLAYER_JS = () => {
  document.documentElement.classList.add("sj-capture");
  document
    .querySelectorAll("#yt-player-container, #ytp-mini-footer, .ytp-mini-footer, .yt-player")
    .forEach((el) => {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
    });
};

const PLAYER_MASK = "#yt-player-container, #ytp-mini-footer, .ytp-mini-footer, .yt-player";

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Read a PNG's pixel dimensions straight out of its IHDR chunk. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Display URL for the frames — no scheme, no www. */
const displayUrl = (slug) => `${SITE}/${slug}`.replace(/^https?:\/\/(www\.)?/, "");

/** Long artist names have to shrink or they overflow the frame. */
function nameSize(name, base) {
  const n = String(name).length;
  if (n > 26) return Math.round(base * 0.6);
  if (n > 18) return Math.round(base * 0.74);
  if (n > 12) return Math.round(base * 0.87);
  return base;
}

function parseArgs(argv) {
  const o = { slugs: [], only: null, limit: 0, dryRun: false, list: false, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") o.list = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--limit") o.limit = parseInt(argv[++i], 10) || 0;
    else if (a === "--out") o.outDir = argv[++i];
    else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else o.slugs.push(a.toLowerCase());
  }
  return o;
}

function selectShots(only) {
  if (!only) return ALL_SHOTS;
  const want = new Set(only.split(",").map((s) => s.trim()).filter(Boolean));
  const shots = ALL_SHOTS.filter((s) => want.has(s.id));
  if (!shots.length) {
    console.error(`--only matched nothing. Valid: ${ALL_SHOTS.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }
  return shots;
}

async function waitForArtistReady(page) {
  await page.waitForFunction(
    () => {
      const wrap =
        document.getElementById("tl-wrap") || document.getElementById("alltracks-wrap");
      if (!wrap) return false;
      return !!(
        wrap.querySelector("[data-tl-item]") ||
        wrap.querySelector(".list-album-row") ||
        wrap.querySelector(".top-tracks-tbl tbody tr") ||
        wrap.querySelector("img")
      );
    },
    { timeout: NAV_TIMEOUT }
  );
  await page.waitForTimeout(1500);
}

async function applyState(page, { view, expand }) {
  await page.evaluate(
    ({ view, expand }) => {
      if (typeof setViewMode !== "function") throw new Error("setViewMode missing");
      // Expanded state carries between shots and leaves the next shot laying
      // out from stale state, which misaligns the timeline connector lines.
      // Collapsing first forces every shot to start from a clean baseline.
      if (typeof collapseAllTracks === "function") collapseAllTracks();
      setViewMode(view);
      if (view !== "alltracks" && view !== "playlists") {
        if (expand) expandAllTracks();
        else collapseAllTracks();
      }
    },
    { view, expand }
  );
  await page.waitForTimeout(view === "alltracks" ? 900 : 1000);
  if (expand) await page.waitForTimeout(900);
  await page.evaluate(HIDE_PLAYER_JS);
  await page.evaluate(async () => {
    const root =
      document.getElementById("tl-wrap") ||
      document.getElementById("alltracks-wrap") ||
      document.querySelector("main");
    if (!root) return;
    await Promise.all(
      [...root.querySelectorAll("img")].map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((res) => {
              img.addEventListener("load", res, { once: true });
              img.addEventListener("error", res, { once: true });
              setTimeout(res, 3000);
            })
      )
    );
  });
}

async function captureStage(page, shot) {
  await page.evaluate(HIDE_PLAYER_JS);
  const opts = {
    type: "png",
    animations: "disabled",
    mask: [page.locator(PLAYER_MASK)],
    maskColor: "#0a0a0a",
  };
  if (shot.view === "alltracks") {
    const wrap = page.locator("#alltracks-wrap");
    if (await wrap.count()) return wrap.screenshot(opts);
  }
  const tl = page.locator("#tl-wrap");
  if (await tl.count()) return tl.screenshot(opts);
  const all = page.locator("#alltracks-wrap");
  if (await all.count()) return all.screenshot(opts);
  return page.locator("main").screenshot(opts);
}

async function measureCatalog(page) {
  return page.evaluate(() => {
    const ids = typeof selectedIds !== "undefined" ? [...selectedIds] : [];
    const vis = ids
      .flatMap((aid) => albums[aid] || [])
      .filter((a) => (typeof isAlbumVisible === "function" ? isAlbumVisible(a.id) : true));
    let maxTracks = 0;
    let total = 0;
    for (const alb of vis) {
      const n = (tracks[alb.artist_id] || []).filter((t) => t.album_id === alb.id).length;
      total += n;
      if (n > maxTracks) maxTracks = n;
    }
    // The page already knows when YouTube counts were last snapshotted, so the
    // og card can date the numbers it is showing rather than guess.
    const sync = typeof ytLastSync !== "undefined" && ytLastSync ? new Date(ytLastSync) : null;
    return {
      albumCount: vis.length || 1,
      maxTracks,
      trackCount: total,
      ytSync: sync && !isNaN(sync) ? sync.toISOString().slice(0, 10) : null,
    };
  });
}

// Mirrors sjExportViewportFor in public/index.html. Albums List is a vertical
// stack, so its height grows with albums AND tracks rather than with the widest
// single panel.
function viewportForShot(catalog, shot) {
  const n = Math.max(1, catalog.albumCount);
  const per = shot.expand ? PX_PER_ALBUM_EXPANDED : PX_PER_ALBUM_COLLAPSED;
  const width =
    shot.view === "list" || shot.view === "alltracks"
      ? 1480
      : Math.min(
          VIEWPORT_MAX_W,
          Math.max(n <= 2 ? 960 : VIEWPORT_MIN_W, Math.ceil(n * per + 280))
        );
  const trackRows = Math.max(catalog.maxTracks || 8, 8);
  // The list branch comes first: Albums List grows with albums AND tracks
  // whether or not the tracks are open, so the generic expanded formula
  // (written for the horizontal charts) would cut the stack short.
  const height =
    shot.view === "list"
      ? Math.min(6000, Math.max(1200, 260 + n * 130 + (catalog.trackCount || trackRows) * 40))
      : shot.expand
        ? Math.min(VIEWPORT_MAX_H, Math.max(VIEWPORT_MIN_H, 460 + trackRows * 48 + 320))
        : shot.view === "alltracks"
          ? 1200
          : VIEWPORT_BASE.height;
  return { width, height };
}

async function composeFrame(browser, { size, html }) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForTimeout(150);
    return await page.screenshot({ type: "png" });
  } finally {
    await page.close();
  }
}

function reelHtml({ artistName, slug, label, stagePng, catalog }) {
  // The card hugs the chart's own aspect ratio, and the whole thing is a
  // centered stack. The charts are wide and short, so a 9:16 frame always has
  // room left over — this makes that room look deliberate instead of leaving a
  // giant empty bordered box.
  const { width: sw, height: sh } = pngSize(stagePng);
  const meta = [
    `${catalog.albumCount} album${catalog.albumCount === 1 ? "" : "s"}`,
    catalog.trackCount ? `${catalog.trackCount} tracks` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width:${REEL.width}px; height:${REEL.height}px; background:#0a0a0a; color:#f5f5f5;
    font-family: Inter, system-ui, sans-serif; overflow:hidden; }
  .frame { width:100%; height:100%; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:64px; padding:64px 28px;
    background: radial-gradient(1000px 620px at 50% 0%, #1a1220 0%, #0a0a0a 60%), #0a0a0a; }
  .brand { text-align:center; }
  .brand .mark { font-size:28px; font-weight:800; letter-spacing:.1em; color:#9b7bb8; }
  .brand .artist { margin-top:12px; font-size:${nameSize(artistName, 56)}px; font-weight:800;
    line-height:1.06; overflow-wrap:anywhere; }
  .brand .meta { margin-top:12px; font-size:22px; color:#b9b9b9; letter-spacing:.02em; }
  .brand .mode { margin-top:18px; display:inline-block; font-size:18px; letter-spacing:.14em;
    text-transform:uppercase; color:#ff6b35; border:1px solid #ff6b3544; padding:8px 14px;
    border-radius:999px; }
  .stage-wrap { flex:0 1 auto; aspect-ratio:${sw} / ${sh}; width:100%; max-height:52%;
    border:1px solid #ffffff14; border-radius:20px; background:#050505; overflow:hidden; }
  .stage-wrap img { width:100%; height:100%; object-fit:contain; display:block; }
  .foot { text-align:center; font-size:22px; letter-spacing:.04em; color:#bdbdbd; }
  .foot .cta { margin-top:10px; font-size:28px; font-weight:600; color:#fff; }
  .foot .url { color:#ff6b35; overflow-wrap:anywhere; }
</style></head><body><div class="frame">
  <div class="brand">
    <div class="mark">SUFFERING JUKEBOX</div>
    <div class="artist">${esc(artistName)}</div>
    <div class="meta">${esc(meta)}</div>
    <div class="mode">${esc(String(label).toUpperCase())}</div>
  </div>
  <div class="stage-wrap"><img src="data:image/png;base64,${stagePng.toString(
    "base64"
  )}" alt=""/></div>
  <div class="foot"><div>Open &amp; play</div>
    <div class="cta"><span class="url">${esc(displayUrl(slug))}</span></div></div>
</div></body></html>`;
}

// mm/dd/yyyy, in UTC, so the label does not shift with the machine the job
// happens to run on.
function fmtUpdated(iso) {
  const d = iso ? new Date(iso + "T00:00:00Z") : new Date();
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

function ogHtml({ artistName, slug, stagePng, catalog }) {
  const bits = [
    `${catalog.albumCount} album${catalog.albumCount === 1 ? "" : "s"}`,
    catalog.trackCount ? `${catalog.trackCount} tracks` : null,
    `YouTube Views updated ${fmtUpdated(catalog.ytSync)}`,
  ].filter(Boolean);
  return `<!doctype html><html><head><meta charset="utf-8"/><style>
  * { box-sizing:border-box; margin:0; padding:0; }
  html, body { width:${OG.width}px; height:${OG.height}px; background:#0a0a0a; color:#f5f5f5;
    font-family: Inter, system-ui, sans-serif; overflow:hidden; }
  .card { width:100%; height:100%; display:grid;
    grid-template-columns:minmax(0,420px) minmax(0,1fr);
    background: radial-gradient(760px 420px at 0% 0%, #1a1220 0%, #0a0a0a 62%), #0a0a0a; }
  .left { padding:52px 28px 44px 52px; display:flex; flex-direction:column;
    justify-content:center; gap:16px; min-width:0; }
  .mark { font-size:19px; font-weight:800; letter-spacing:.16em; color:#9b7bb8; }
  .artist { font-size:${nameSize(artistName, 56)}px; font-weight:800; line-height:1.02;
    letter-spacing:-.01em; overflow-wrap:anywhere; }
  .meta { font-size:19px; color:#b9b9b9; letter-spacing:.02em; }
  .url { margin-top:6px; font-size:18px; font-weight:600; color:#ff6b35;
    overflow-wrap:anywhere; }
  .right { position:relative; overflow:hidden; border-left:1px solid #ffffff12; background:#050505; }
  .right img { width:100%; height:100%; object-fit:cover; object-position:left top; display:block; }
  .fade { position:absolute; inset:0;
    background:linear-gradient(90deg,#0a0a0a 0%, #0a0a0a00 14%); }
</style></head><body><div class="card">
  <div class="left">
    <div class="mark">SUFFERING JUKEBOX</div>
    <div class="artist">${esc(artistName)}</div>
    <div class="meta">${esc(bits.join(" · "))}</div>
    <div class="url">${esc(displayUrl(slug))}</div>
  </div>
  <div class="right"><img src="data:image/png;base64,${stagePng.toString(
    "base64"
  )}" alt=""/><div class="fade"></div></div>
</div></body></html>`;
}

async function readArtistName(page, fallback) {
  return page.evaluate((fb) => {
    if (window.__SLUG_ARTIST__?.name) return window.__SLUG_ARTIST__.name;
    const t = (document.querySelector("header p, .site-sub, h1 + p")?.textContent || "").trim();
    return t.match(/The (.+?) jukebox/i)?.[1] || fb;
  }, fallback);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 32);

async function publish({ artist, shotId, format, buffer, catalog, opts, scope = "artist" }) {
  const base =
    format === "og" ? "og.png" : format === "reel" ? `reel-${shotId}.png` : `${shotId}.png`;
  // The all-artists variant is a different picture of the same page, so it gets
  // its own filename rather than its own directory - the serving route is two
  // segments deep and stays that way.
  const file = scope === "all" ? `all-${base}` : base;
  const key = `${KEY_PREFIX}/${artist.slug}/${file}`;
  // Real pixel dimensions, not the viewport — stage shots are element captures
  // at deviceScaleFactor 2, so the two are never the same number.
  const size = pngSize(buffer);

  if (opts.outDir) {
    const dir = join(opts.outDir, artist.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), buffer);
  }
  if (opts.dryRun) return key;

  await uploadPng(key, buffer);
  await recordShareImage({
    artist_id: artist.id,
    slug: artist.slug,
    shot_id: shotId,
    format,
    scope,
    b2_key: key,
    width: size.width,
    height: size.height,
    bytes: buffer.byteLength,
    album_count: catalog.albumCount,
    track_count: catalog.trackCount || null,
    content_hash: sha(buffer),
    captured_at: new Date().toISOString(),
  });
  return key;
}

/** Artist ids loaded alongside the primary one, e.g. Purple Mountains on the
 *  Silver Jews page. Empty for a page that only ever has the one artist. */
async function readAllScopeIds(page) {
  return page.evaluate(() => {
    try {
      if (typeof sjExportOtherArtists !== "function") return [];
      if (!sjExportOtherArtists().length) return [];
      return sjExportScopeArtistIds("all");
    } catch {
      return [];
    }
  });
}

async function captureArtist(browser, artist, shots, opts, scope = "artist", allIds = []) {
  const page = await browser.newPage({ viewport: VIEWPORT_BASE, deviceScaleFactor: 2 });
  let published = 0;
  let scopeIds = [];
  try {
    // The app renders a specific artist set when asked, which is how the
    // all-artists variant gets captured without any special-casing here.
    const url =
      scope === "all"
        ? `${SITE}/${artist.slug}?sj_export=1&sj_export_scope=all&sj_export_artists=${allIds.join(",")}`
        : `${SITE}/${artist.slug}`;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await waitForArtistReady(page);
    await page.addStyleTag({ content: CAPTURE_CSS });
    await page.evaluate(HIDE_PLAYER_JS);

    const artistName = await readArtistName(page, artist.name || artist.slug);
    const catalog = await measureCatalog(page);
    if (scope === "artist") scopeIds = await readAllScopeIds(page);
    console.log(
      `  ${artistName} · ${catalog.albumCount} albums · ${catalog.trackCount} tracks` +
        (scope === "all" ? " [all artists]" : "")
    );

    for (const shot of shots) {
      const vp = viewportForShot(catalog, shot);
      await page.setViewportSize(vp);
      await page.waitForTimeout(400);
      await applyState(page, shot);

      // Layout can widen further after expand — grow once more if it overflows.
      // Albums List is a fixed-width vertical stack, so it never needs this.
      if (shot.expand && shot.view !== "list") {
        const needed = await page.evaluate(() => {
          const wrap = document.getElementById("tl-wrap");
          const sw = wrap?.scrollWidth || 0;
          const stageEl =
            wrap?.querySelector("[data-tl-item]")?.closest("div[style]") ||
            wrap?.firstElementChild;
          const explicit = stageEl ? parseInt(stageEl.style?.width || "0", 10) : 0;
          return Math.max(sw, explicit, 0);
        });
        if (needed > vp.width - 40) {
          const wider = Math.min(VIEWPORT_MAX_W, needed + 80);
          if (wider > vp.width) {
            await page.setViewportSize({ width: wider, height: vp.height });
            await page.waitForTimeout(350);
            await applyState(page, shot);
            vp.width = wider;
          }
        }
      }

      const stagePng = await captureStage(page, shot);
      await publish({
        artist,
        shotId: shot.id,
        format: "stage",
        buffer: stagePng,
        catalog,
        opts,
        scope,
      });
      published++;

      const reelPng = await composeFrame(browser, {
        size: REEL,
        html: reelHtml({
          artistName,
          slug: artist.slug,
          label: shot.label,
          stagePng,
          catalog,
        }),
      });
      await publish({
        artist,
        shotId: shot.id,
        format: "reel",
        buffer: reelPng,
        catalog,
        opts,
        scope,
      });
      published++;

      if (shot.ogSource && scope === "artist") {
        const ogPng = await composeFrame(browser, {
          size: OG,
          html: ogHtml({ artistName, slug: artist.slug, stagePng, catalog }),
        });
        await publish({
          artist,
          shotId: shot.id,
          format: "og",
          buffer: ogPng,
          catalog,
          opts,
          scope,
        });
        published++;
      }
      console.log(`    ok ${shot.id} @ ${vp.width}x${vp.height}`);
    }
  } finally {
    await page.close();
  }
  return { published, scopeIds };
}

// ── run ──────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const shots = selectShots(opts.only);
const started = Date.now();

let artists = await listArtists();
if (opts.slugs.length) artists = artists.filter((a) => opts.slugs.includes(a.slug.toLowerCase()));
if (opts.limit) artists = artists.slice(0, opts.limit);

if (opts.list) {
  for (const a of artists) {
    console.log(`${a.slug}\t${a.is_community ? "community" : "official"}\t${a.name}`);
  }
  console.log(`\n${artists.length} artists with slugs`);
  process.exit(0);
}

if (!artists.length) {
  console.error("No artists matched.");
  process.exit(1);
}

console.log(
  `Suffering Jukebox share images — ${artists.length} artist(s) x ${shots.length} shot(s)` +
    (opts.dryRun ? " [DRY RUN - no upload, no manifest write]" : "")
);

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--no-sandbox"],
});

let ok = 0;
let failed = 0;
let images = 0;
const done = [];
try {
  for (const artist of artists) {
    console.log(`\n-> ${artist.slug}`);
    try {
      const res = await captureArtist(browser, artist, shots, opts);
      images += res.published;
      // Pages that load a second artist (Purple Mountains on the Silver Jews
      // page) also offer an all-artists export, which is a different picture.
      if (res.scopeIds.length > 1) {
        const all = await captureArtist(browser, artist, shots, opts, "all", res.scopeIds);
        images += all.published;
      }
      done.push(artist.slug);
      ok++;
    } catch (err) {
      failed++;
      console.error(`  FAILED ${artist.slug}: ${err?.message || err}`);
    }
  }
} finally {
  await browser.close();
}

// Only prune on a full, healthy sweep — a partial run must not delete rows for
// artists it simply did not reach tonight.
if (!opts.dryRun && !opts.slugs.length && !opts.limit && !opts.only && failed === 0) {
  try {
    const removed = await pruneMissing(done);
    if (removed) console.log(`\nPruned ${removed} stale manifest row(s).`);
  } catch (err) {
    console.error(`Prune skipped: ${err?.message || err}`);
  }
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nDone in ${mins}m — ${ok} artist(s) ok, ${failed} failed, ${images} image(s).`);
if (ok === 0) process.exit(1);
