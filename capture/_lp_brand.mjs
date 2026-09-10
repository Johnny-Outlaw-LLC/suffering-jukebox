// Prepare Listening Party's header mark from the OFFICIAL brand asset.
//
// The canonical artwork lives at outlawapps.online/branding, and the files in
// public/brand/lp are downloaded from there:
//
//   logo.png         1024 master            favicon-32.png / favicon.png  size pack
//
// Those are used untouched. The one thing that needs doing is the header: the
// master ships inside a white margin, which reads as a white halo against the
// near-black page, so this trims to the ink and rounds nothing else.
//
// NOTE: Listening Party has no official wordmark - the branding page offers a
// Wordmark download for Suffering Jukebox and only a square mark for this one.
// So the header shows the mark, and nothing here invents lettering to sit
// beside it.
//
//   cd capture && node _lp_wordmark.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'C:/AI Projects/Projects/Suffering Jukebox/suffering-jukebox-fresh/public/brand/lp';
const SRC = `data:image/png;base64,${readFileSync(`${DIR}/logo.png`).toString('base64')}`;
const OUT = 512;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
await page.setContent('<img id="i">');

const png = await page.evaluate(
  async ([src, out]) => {
    const img = document.getElementById('i');
    img.src = src;
    await img.decode();

    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);

    // The white is not a margin, it is opaque corners around the rounded
    // square. Flood fill from the edges so only white REACHABLE FROM OUTSIDE
    // is cleared - the monkey and the stars are white too and must survive.
    const W = c.width;
    const H = c.height;
    const near = (i) => data[i] > 236 && data[i + 1] > 236 && data[i + 2] > 236;
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let x = 0; x < W; x++) {
      stack.push(x, x + (H - 1) * W);
    }
    for (let y = 0; y < H; y++) {
      stack.push(y * W, W - 1 + y * W);
    }
    let cleared = 0;
    while (stack.length) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      if (!near(i)) continue;
      data[i + 3] = 0;
      cleared++;
      const x = p % W;
      const y = (p / W) | 0;
      if (x > 0) stack.push(p - 1);
      if (x < W - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - W);
      if (y < H - 1) stack.push(p + W);
    }
    g.putImageData(new ImageData(data, W, H), 0, 0);

    // Now trim to what is left.
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    const o = document.createElement('canvas');
    o.width = out;
    o.height = out;
    o.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, out, out);
    return { url: o.toDataURL('image/png'), x0, y0, w, h, sw: W, sh: H, cleared };
  },
  [SRC, OUT]
);

writeFileSync(`${DIR}/header-mark.png`, Buffer.from(png.url.split(',')[1], 'base64'));
console.log(`logo.png ${png.sw}x${png.sh} -> cleared ${png.cleared} white px, ink at (${png.x0},${png.y0}) ${png.w}x${png.h}`);
console.log(`header-mark.png ${OUT}x${OUT}`);

await browser.close();
