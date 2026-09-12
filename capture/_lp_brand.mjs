// Listening Party brand assets under public/brand/lp/.
//
// Canonical artwork lives at outlawapps.online/branding:
//
//   listening-party-logo.png / header-mark.png / wordmark.png
//       Official horizontal lockup (emblem + name + tagline). Used as the
//       site header mark (surface.textLogo) — companion HTML title stays empty
//       so the words are not drawn twice.
//   logo.png / listening-party-icon.png / listening-party-badge (on OA)
//       Standalone circular badge. Source for favicon.png / favicon-32.png
//       and app icons.
//   og-image.png
//       1200x630 social card (surface.ogImage).
//
// This script only rebuilds the favicons from logo.png (the badge). It does
// NOT touch header-mark.png — an earlier version cropped the badge into a
// square "header" and that is wrong now that the wide lockup exists.
//
//   cd capture && node _lp_brand.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const DIR = new URL('../public/brand/lp/', import.meta.url);
const srcPath = new URL('logo.png', DIR);
const SRC = `data:image/png;base64,${readFileSync(srcPath).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
await page.setContent('<img id="i">');

async function makeFavicon(size) {
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

      // Clear opaque white only reachable from the edges (badge corners).
      const W = c.width;
      const H = c.height;
      const near = (i) => data[i] > 236 && data[i + 1] > 236 && data[i + 2] > 236;
      const seen = new Uint8Array(W * H);
      const stack = [];
      for (let x = 0; x < W; x++) stack.push(x, x + (H - 1) * W);
      for (let y = 0; y < H; y++) stack.push(y * W, W - 1 + y * W);
      while (stack.length) {
        const p = stack.pop();
        if (seen[p]) continue;
        seen[p] = 1;
        const i = p * 4;
        if (!near(i)) continue;
        data[i + 3] = 0;
        const x = p % W;
        const y = (p / W) | 0;
        if (x > 0) stack.push(p - 1);
        if (x < W - 1) stack.push(p + 1);
        if (y > 0) stack.push(p - W);
        if (y < H - 1) stack.push(p + W);
      }
      g.putImageData(new ImageData(data, W, H), 0, 0);

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
      const side = Math.max(w, h);
      const o = document.createElement('canvas');
      o.width = out;
      o.height = out;
      const og = o.getContext('2d');
      const scale = out / side;
      const dw = w * scale;
      const dh = h * scale;
      og.drawImage(c, x0, y0, w, h, (out - dw) / 2, (out - dh) / 2, dw, dh);
      return o.toDataURL('image/png');
    },
    [SRC, size]
  );
  return Buffer.from(png.split(',')[1], 'base64');
}

writeFileSync(new URL('favicon.png', DIR), await makeFavicon(192));
writeFileSync(new URL('favicon-32.png', DIR), await makeFavicon(32));
console.log('favicon.png 192x192 and favicon-32.png 32x32 from logo.png (badge)');
console.log('header-mark.png left untouched (wide lockup).');

await browser.close();
