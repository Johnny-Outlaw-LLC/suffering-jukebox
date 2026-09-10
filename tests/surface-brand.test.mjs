// @suite Brand surfaces
// @area Platform
// @covers src/lib/surface.ts
// @covers src/lib/surface-head.ts
//
// Suffering Jukebox and Listening Party are one codebase serving two brands.
// The risk that replaces the one a fork would have had is DRIFT: the server's
// idea of a brand and public/index.html's fallback copy of it quietly
// disagreeing, so half the app says one name and half says the other.
//
// Two things are pinned here. First, that serving Suffering Jukebox through
// the new rewrite changes nothing at all - if that ever stops being true the
// live site has moved without anyone deciding it should. Second, that the
// client's SJ_BRAND defaults are exactly what the server would have sent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { loadTs, readRepoFile, dashboardHtml } from './_load.mjs';

const surface = loadTs('src/lib/surface.ts');
const head = loadTs('src/lib/surface-head.ts', { 'lib/surface': surface });

const SJ = surface.SURFACES.sj;
const LP = surface.SURFACES.lp;

const indexHtml = readRepoFile('public/index.html');
const headOf = (html) => html.slice(0, html.indexOf('</head>'));

/** The head as served, minus the one tag this rewrite always adds. */
function headWithoutInjection(html) {
  return headOf(html).replace(/<script>window\.__SURFACE__=.*?<\/script>\n/s, '');
}

// ── Suffering Jukebox is untouched ────────────────────────────────────────

test('serving Suffering Jukebox rewrites nothing but the injected surface', () => {
  const out = head.applySurfaceHead(indexHtml, SJ);
  assert.equal(headWithoutInjection(out), headOf(indexHtml));
});

test('the home-page overrides are the copy already in the file', () => {
  // Every value the home route passes is what index.html was authored with, so
  // the rewrite is still an identity with the overrides applied. This is what
  // stops a wording change in surface.ts silently editing the live meta tags.
  const out = head.applySurfaceHead(indexHtml, SJ, {
    title: SJ.title,
    description: SJ.description,
    ogDescription: SJ.ogDescription,
    twitterDescription: SJ.twitterDescription,
    keywords: SJ.keywords,
    url: `${SJ.url}/`,
    image: SJ.ogImage,
    jsonLd: SJ.homeJsonLd,
  });
  assert.equal(headWithoutInjection(out), headOf(indexHtml));
});

test('the body is never rewritten, so the changelog keeps its history', () => {
  const out = head.applySurfaceHead(indexHtml, LP);
  const body = out.slice(out.indexOf('</head>'));
  assert.ok(
    body.includes('Launched Suffering Jukebox'),
    'the changelog records what actually shipped and must not be rebranded',
  );
});

// ── Listening Party ───────────────────────────────────────────────────────

test('no Suffering Jukebox string survives in a Listening Party head', () => {
  const out = headOf(head.applySurfaceHead(indexHtml, LP));
  assert.ok(!out.includes('Suffering Jukebox'), 'brand name leaked into the LP head');
  assert.ok(!out.includes('sufferingjukebox.stream'), 'SJ host leaked into the LP head');
  assert.ok(out.includes('Listening Party'));
  assert.ok(out.includes('listeningparty.stream'));
});

test('Listening Party art is its own, and Suffering Jukebox art stays at the root', () => {
  const lp = headOf(head.applySurfaceHead(indexHtml, LP));
  assert.ok(lp.includes('/brand/lp/favicon-32.png'));
  assert.ok(lp.includes(LP.ogImage));
  assert.ok(LP.ogImage.startsWith(`${LP.url}/`), 'og:image has to be absolute for scrapers');
  assert.ok(!/href="\/favicon/.test(lp), 'LP must not fall back to the SJ favicon');
  // The declared size has to describe the file being served, not the shape a
  // social card is supposed to be.
  assert.ok(lp.includes(`<meta property="og:image:width" content="${LP.ogImageSize.w}">`));
  assert.ok(lp.includes(`<meta property="og:image:height" content="${LP.ogImageSize.h}">`));

  // SJ keeps plain static paths: routing its art through a handler to gain
  // nothing would cost every visitor a hop.
  const sj = headOf(head.applySurfaceHead(indexHtml, SJ));
  assert.ok(sj.includes('href="/favicon-32.png"'));
  assert.equal(SJ.assetBase, '');
});

test('every brand asset a head points at is actually on disk', () => {
  // A missing favicon is invisible in code review and obvious to a visitor.
  for (const s of [SJ, LP]) {
    const paths = new Set([
      s.textLogo,
      `${s.assetBase}/favicon-32.png`,
      `${s.assetBase}/favicon.png`,
      s.ogImage.slice(s.url.length),
    ]);
    for (const p of paths) {
      assert.ok(
        existsSync(new URL(`../public${p}`, import.meta.url)),
        `${s.id}: public${p} is referenced but missing`,
      );
    }
  }
});

test('the browser chrome colour follows the brand', () => {
  const lp = headOf(head.applySurfaceHead(indexHtml, LP));
  assert.ok(lp.includes(`<meta name="theme-color" content="${LP.themeColor}">`));
  assert.ok(!lp.includes(`content="${SJ.themeColor}"`), 'SJ theme-color left in the LP head');

  // Deliberately NOT asserting the accent is gone from the head. The <style>
  // block lives there and spells #ff6b35 out hundreds of times, so Listening
  // Party still paints orange until the palette moves to a custom property.
  // That is a separate job from the brand seam, and pretending otherwise here
  // would either fail forever or tempt a blind find-and-replace through CSS.
  assert.ok(lp.includes(SJ.themeColor), 'the accent is still hard-coded in the stylesheet');
});

// ── The injected surface ──────────────────────────────────────────────────

test('window.__SURFACE__ is injected before the dashboard script and parses', () => {
  const out = head.applySurfaceHead(indexHtml, LP);
  const m = out.match(/<script>window\.__SURFACE__=(.*?)<\/script>/s);
  assert.ok(m, 'no surface was injected');
  assert.ok(out.indexOf(m[0]) < out.indexOf('</head>'), 'surface must be in the head');
  assert.deepStrictEqual(JSON.parse(m[1]), surface.publicSurface(LP));
});

test('an injected surface cannot break out of its script tag', () => {
  const evil = { ...LP, name: '</script><script>alert(1)</script>' };
  const out = head.applySurfaceHead(indexHtml, evil);
  const m = out.match(/<script>window\.__SURFACE__=(.*?)<\/script>/s);
  assert.ok(!m[1].includes('</script>'), 'a closing tag survived into the injected JSON');
  assert.equal(JSON.parse(m[1]).name, evil.name);
});

// ── The drift guard ───────────────────────────────────────────────────────

/** The SJ_BRAND defaults literal out of public/index.html, evaluated here. */
function clientBrandDefaults() {
  const at = indexHtml.indexOf('const SJ_BRAND = Object.assign({');
  assert.ok(at >= 0, 'SJ_BRAND is gone from public/index.html');
  const end = indexHtml.indexOf('}, (window.__SURFACE__ || {}));', at);
  assert.ok(end > at, 'SJ_BRAND no longer merges window.__SURFACE__ over its defaults');
  const literal = indexHtml.slice(at + 'const SJ_BRAND = Object.assign('.length, end + 1);
  return new Function(`return (${literal});`)();
}

test('the dashboard fallback brand is exactly what the server would send for SJ', () => {
  const client = clientBrandDefaults();
  const server = surface.publicSurface(SJ);
  // tagline is deliberately blank in the file: the header element is filled in
  // per view, and shipping a default would flash the wrong words on load.
  assert.equal(client.tagline, '');
  delete client.tagline;
  const { tagline: _drop, ...rest } = server;
  assert.deepStrictEqual(client, rest);
});

test('every brand-bearing string in the dashboard reads through SJ_BRAND', () => {
  // The head is rewritten server-side and the changelog is history; everything
  // between them is live code and must not name the product directly.
  const from = indexHtml.indexOf('</head>');
  const to = indexHtml.indexOf('const SJ_CHANGELOG');
  assert.ok(to > from);
  const body = indexHtml.slice(from, to);

  const allowed = [
    // The SJ_BRAND defaults themselves, and the comments explaining them.
    'const SJ_BRAND = Object.assign({',
    // Markup carrying data-sj-brand / data-sj-logo, which sjApplyBrandToDom
    // rewrites at startup. Listed so a NEW hardcoded string still fails.
    'data-sj-brand=',
    'data-sj-logo',
  ];
  const offenders = body
    .split('\n')
    .map((line, i) => [i, line])
    .filter(([, line]) => /Suffering Jukebox|sufferingjukebox/.test(line))
    .filter(([, line]) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .filter(([, line]) => !allowed.some((a) => line.includes(a)))
    // Inside the SJ_BRAND literal, which the previous test pins against the server.
    .filter(([, line]) => !/^\s{2}(name|url|host|origins|authScheme|shareText|redditSub|textLogo):/.test(line));

  assert.deepStrictEqual(
    offenders.map(([, line]) => line.trim()),
    [],
    'these lines name the brand directly instead of reading SJ_BRAND',
  );
});

// ── Resolution ────────────────────────────────────────────────────────────

test('a hostname resolves to its brand, www and subdomains included', () => {
  assert.equal(surface.surfaceFromHost('sufferingjukebox.stream').id, 'sj');
  assert.equal(surface.surfaceFromHost('www.sufferingjukebox.stream').id, 'sj');
  assert.equal(surface.surfaceFromHost('listeningparty.stream').id, 'lp');
  assert.equal(surface.surfaceFromHost('WWW.LISTENINGPARTY.STREAM:443').id, 'lp');
  assert.equal(surface.surfaceFromHost('listening-party.vercel.app'), null);
  assert.equal(surface.surfaceFromHost('localhost'), null);
  assert.equal(surface.surfaceFromHost(''), null);
});

test('SURFACE_ID wins over the host, and an unknown host falls back to SJ', () => {
  const prev = process.env.SURFACE_ID;
  try {
    process.env.SURFACE_ID = 'lp';
    assert.equal(surface.currentSurface('www.sufferingjukebox.stream').id, 'lp');
    process.env.SURFACE_ID = 'nonsense';
    assert.equal(surface.currentSurface('listeningparty.stream').id, 'lp');
    delete process.env.SURFACE_ID;
    assert.equal(surface.currentSurface('localhost:3021').id, 'sj');
    assert.equal(surface.currentSurface(null).id, 'sj');
  } finally {
    if (prev === undefined) delete process.env.SURFACE_ID;
    else process.env.SURFACE_ID = prev;
  }
});

test('the two brands agree on shape, so neither can grow a field alone', () => {
  assert.deepStrictEqual(Object.keys(SJ).sort(), Object.keys(LP).sort());
  assert.deepStrictEqual(
    Object.keys(SJ.features).sort(),
    Object.keys(LP.features).sort(),
  );
});

test('Listening Party leads with playlists and has no artist pages', () => {
  assert.equal(LP.features.defaultLandingTab, 'playlists');
  assert.equal(LP.features.artistPages, false);
  assert.equal(LP.features.artistJukebox, false);
  assert.equal(SJ.features.defaultLandingTab, 'explore');
  assert.equal(SJ.features.artistPages, true);
});

test('the dashboard is unaware of any brand but the one it is serving', () => {
  assert.ok(
    !dashboardHtml.includes('Listening Party'),
    'public/index.html must not name the other brand; it reads window.__SURFACE__',
  );
});
