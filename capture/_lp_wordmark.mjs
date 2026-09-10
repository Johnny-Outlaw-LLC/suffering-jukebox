// Build Listening Party's brand art from the REAL mark.
//
// public/brand/lp/logo-mark.jpg is the designed logo: a monkey in headphones
// with a star-striped shirt on a purple rounded square. logo-mark.svg and
// icon.svg beside it are crude hand-coded approximations of it - do not build
// from those, which is how a first pass produced a lockup nobody recognised.
//
// Outputs, all PNG:
//   wordmark.png     the header lockup: mark beside "listeningparty.stream"
//   favicon-32.png   \ the mark alone, cropped square
//   favicon.png      /
//
// PNG rather than SVG because an SVG loaded through <img> cannot fetch Inter
// and would reshape itself per machine, and because the mark is raster anyway.
//
// Re-run after changing the mark, the words, or the accent:
//   cd capture && node _lp_wordmark.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'C:/AI Projects/Projects/Suffering Jukebox/suffering-jukebox-fresh/public/brand/lp';
const ACCENT = '#9D4EDD';
const SCALE = 4;

const jpg = readFileSync(`${DIR}/logo-mark.jpg`).toString('base64');
const SRC = `data:image/jpeg;base64,${jpg}`;

const browser = await chromium.launch();

// ── Find the artwork inside its white margin ─────────────────────────────────
// The file is a rounded purple square floating on white. Cropping to the ink
// is what lets the mark sit flush in a header instead of inside a white box.
const probe = await browser.newPage();
await probe.setContent('<img id="i">');
const box = await probe.evaluate(async (src) => {
  const img = document.getElementById('i');
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const { data } = g.getImageData(0, 0, c.width, c.height);
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      // Anything that is not near-white is artwork.
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return { w: c.width, h: c.height, x0, y0, x1, y1 };
}, SRC);
await probe.close();

const cropW = box.x1 - box.x0 + 1;
const cropH = box.y1 - box.y0 + 1;
console.log(`source ${box.w}x${box.h} -> artwork at (${box.x0},${box.y0}) ${cropW}x${cropH}`);

/** CSS that shows only the cropped artwork, scaled to `size` px. */
const markCss = (size) => {
  const sx = size / cropW;
  const sy = size / cropH;
  return `width:${size}px;height:${size}px;flex:none;border-radius:${Math.round(size * 0.22)}px;
    background-image:url('${SRC}');background-repeat:no-repeat;
    background-size:${box.w * sx}px ${box.h * sy}px;
    background-position:-${box.x0 * sx}px -${box.y0 * sy}px;`;
};

async function shoot(html, sel, out, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: SCALE });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  const b = await page.locator(sel).boundingBox();
  const buf = await page.locator(sel).screenshot({ omitBackground: true });
  writeFileSync(`${DIR}/${out}`, buf);
  console.log(
    `  ${out.padEnd(16)} ${Math.round(b.width * SCALE)}x${Math.round(b.height * SCALE)}  ${buf.length} bytes`
  );
  await page.close();
}

// ── The header lockup ────────────────────────────────────────────────────────
// Reproduces the old site's arrangement: mark beside live text, "listening"
// bold + "party" light + ".stream" in the accent, tagline underneath.
await shoot(
  `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap">
<style>
  html,body { margin:0; padding:0; background:transparent; }
  #lockup { display:inline-flex; align-items:center; gap:14px; padding:2px;
            font-family:'Inter',system-ui,sans-serif; color:#fff; }
  #mark { ${markCss(52)} }
  #copy { display:flex; flex-direction:column; gap:3px; line-height:1.05; }
  #word { font-size:27px; font-weight:700; letter-spacing:-1.2px; white-space:nowrap; }
  #word .light { font-weight:400; }
  #word .dot { color:${ACCENT}; }
  #tag { font-size:10px; font-weight:800; letter-spacing:.15em; color:#a99bb5; white-space:nowrap; }
</style>
<div id="lockup">
  <span id="mark"></span>
  <span id="copy">
    <span id="word">listening<span class="light">party</span><span class="dot">.stream</span></span>
    <span id="tag">JOIN THE LISTENING PARTY</span>
  </span>
</div>`,
  '#lockup',
  'wordmark.png',
  { width: 900, height: 200 }
);

// ── The app icon, at both sizes the head asks for ────────────────────────────
for (const [out, size] of [['favicon-32.png', 8], ['favicon.png', 48]]) {
  await shoot(
    `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
  #m{${markCss(size)}border-radius:${Math.round(size * 0.22)}px}</style>
<div id="m"></div>`,
    '#m',
    out,
    { width: size + 4, height: size + 4 }
  );
}

await browser.close();
