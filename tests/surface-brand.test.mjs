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
import { loadTs, loadHtmlFnsInScope, readRepoFile, dashboardHtml } from './_load.mjs';

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
  // The injected window.__SURFACE__ may name the sister site for Integrations.
  // Everything else in the head (title, metas, canonical, favicons) must be LP.
  let out = headOf(head.applySurfaceHead(indexHtml, LP));
  out = out.replace(/<script>window\.__SURFACE__=[\s\S]*?<\/script>/, '');
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
});

test('the accent is a custom property, not a colour typed into rules', () => {
  // Everything translucent used to be spelled rgba(255,107,53,X), which no
  // brand but Suffering Jukebox could ever follow.
  const css = headOf(indexHtml);
  assert.ok(css.includes('--accent-rgb: 255,107,53'), 'the accent triple is not declared');
  assert.ok(!/rgba\(\s*255,\s*107,\s*53/.test(css), 'a literal accent rgba() came back');
  assert.ok(!/#ff6b35[0-9a-f]{2}\b/i.test(css), 'a literal accent-with-alpha came back');

  // What is left is the declaration, the theme-color meta, and var() fallbacks
  // that only apply if the property is somehow undefined.
  const bare = css.match(/#ff6b35\b/gi) || [];
  assert.equal(bare.length, 4, `unexpected bare accent literals in the head: ${bare.length}`);
});

test('a brand with its own accent gets it before the first paint', () => {
  // From script it would repaint after load, and the boot glyph renders before
  // any JS runs - a page that flashed orange then turned purple looks broken.
  const lp = headOf(head.applySurfaceHead(indexHtml, LP));
  assert.ok(lp.includes(`--accent:${LP.accent}`), 'no accent override for LP');
  assert.ok(lp.includes(`--accent-rgb:${LP.accentRgb}`));
  assert.ok(lp.indexOf('--accent:' + LP.accent) < lp.length, 'override must be in the head');

  // Nothing is emitted for the brand the file is already authored as.
  const sj = headOf(head.applySurfaceHead(indexHtml, SJ));
  assert.ok(!sj.includes('<style>:root{--accent:'), 'SJ got a redundant theme override');
});

test('an accent has to be legible on the near-black page', () => {
  // LP's mark colour is a deep purple that works as a tile behind white
  // artwork and would vanish as a highlight. Relative luminance, sRGB.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (hex) => (lum(hex) + 0.05) / (lum('#0a0a0a') + 0.05);
  for (const s of [SJ, LP]) {
    assert.ok(
      contrast(s.accent) >= 3,
      `${s.id}: accent ${s.accent} is only ${contrast(s.accent).toFixed(2)}:1 on the page`,
    );
  }
  assert.ok(contrast(LP.themeColor) < 3, 'LP theme colour is light enough to have been the accent');
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
  // tagline / headerTitle / sister* are deliberately blank in the file: they
  // arrive on window.__SURFACE__, and shipping SJ defaults that name the other
  // brand would break the "unaware of any brand but the one it is serving" rule.
  assert.equal(client.tagline, '');
  assert.equal(client.headerTitle, '');
  assert.equal(client.sisterName, '');
  assert.equal(client.sisterUrl, '');
  delete client.tagline;
  delete client.headerTitle;
  delete client.sisterName;
  delete client.sisterUrl;
  const {
    tagline: _t, headerTitle: _h, sisterName: _sn, sisterUrl: _su, ...rest
  } = server;
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

// ── The landing tab strip ─────────────────────────────────────────────────

/**
 * The tab helpers out of public/index.html, run against a given brand.
 *
 * LANDING_TABS is a const rather than a function so it cannot be lifted the
 * way the functions can; it is parsed out of the same file instead, which is
 * what keeps this test honest about what actually ships.
 */
function tabHelpersFor(s) {
  const at = indexHtml.indexOf('const LANDING_TABS = [');
  assert.ok(at >= 0, 'LANDING_TABS is gone from public/index.html');
  const end = indexHtml.indexOf('];', at);
  const literal = indexHtml.slice(at + 'const LANDING_TABS = '.length, end + 1);
  const scope = {
    LANDING_TABS: new Function(`return (${literal});`)(),
    SJ_BRAND: surface.publicSurface(s),
  };
  return loadHtmlFnsInScope(
    ['landingTabsAvailable', 'landingTabAllowed', 'landingDefaultTab', 'landingClampTab', 'landingTabsHTML'],
    scope,
  );
}

test('Suffering Jukebox offers all three tabs and opens on artists', () => {
  const t = tabHelpersFor(SJ);
  assert.deepStrictEqual(
    t.landingTabsAvailable().map((x) => x.id),
    ['explore', 'playlists', 'songs'],
  );
  assert.equal(t.landingDefaultTab(), 'explore');
});

test('Listening Party offers Home then playlists and opens on Home', () => {
  const t = tabHelpersFor(LP);
  assert.deepStrictEqual(t.landingTabsAvailable().map((x) => x.id), ['home', 'playlists']);
  assert.equal(t.landingDefaultTab(), 'home');
  assert.equal(t.landingTabAllowed('explore'), false);
  assert.equal(t.landingTabAllowed('songs'), false);
  assert.equal(t.landingTabAllowed('home'), true);
});

test('a tab remembered from the other brand does not strand the visitor', () => {
  // sj_landing_tab_v2 survives in localStorage, and a browser that last used
  // Suffering Jukebox arrives at Listening Party still asking for Explore
  // Artists. Without the clamp that renders a tab strip with nothing selected.
  const lp = tabHelpersFor(LP);
  assert.equal(lp.landingClampTab('explore'), 'home');
  assert.equal(lp.landingClampTab('songs'), 'home');
  assert.equal(lp.landingClampTab('playlists'), 'playlists');
  assert.equal(lp.landingClampTab('home'), 'home');

  const sj = tabHelpersFor(SJ);
  assert.equal(sj.landingClampTab('songs'), 'songs');
  assert.equal(sj.landingClampTab('home'), 'explore');
  assert.equal(sj.landingClampTab('nonsense'), 'explore');
  // The back button means Explore Playlists whatever the caller asked for.
  assert.equal(sj.landingClampTab('nonsense', 'playlists'), 'playlists');
});

test('the tab strip marks the active tab and names its handler', () => {
  const html = tabHelpersFor(SJ).landingTabsHTML('songs', 'setLandingTab');
  assert.equal((html.match(/class="landing-tab/g) || []).length, 3);
  assert.ok(html.includes(`class="landing-tab active" onclick="setLandingTab('songs')"`));
  assert.ok(html.includes(`onclick="setLandingTab('explore')"`));

  const lpHtml = tabHelpersFor(LP).landingTabsHTML('home', 'setLandingTab');
  assert.equal((lpHtml.match(/class="landing-tab/g) || []).length, 2);
  assert.ok(!lpHtml.includes('Explore Artists'));
  assert.ok(lpHtml.includes(`class="landing-tab active" onclick="setLandingTab('home')"`));
  assert.ok(lpHtml.includes(`onclick="setLandingTab('playlists')"`));
});

test('the tab strip is built in one place, not three', () => {
  // Three headers render it. They were three copies of the same three buttons,
  // which is three chances for a brand's tabs to disagree with themselves.
  const calls = (indexHtml.match(/landingTabsHTML\(/g) || []).length;
  assert.ok(calls >= 4, `expected the builder plus three call sites, saw ${calls}`);
  assert.ok(
    !/class="landing-tab[^"]*"\s+onclick="(setLandingTab|returnToPlaylistExplorer)\(/.test(indexHtml),
    'a hand-written tab button came back into the strip',
  );
});

test('Listening Party leads with Home and has no artist pages', () => {
  assert.equal(LP.features.defaultLandingTab, 'home');
  assert.equal(LP.features.homeTab, true);
  assert.equal(LP.features.artistPages, false);
  assert.equal(LP.features.artistJukebox, false);
  assert.equal(SJ.features.defaultLandingTab, 'explore');
  assert.equal(SJ.features.homeTab, false);
  assert.equal(SJ.features.artistPages, true);
});

test('the dashboard is unaware of any brand but the one it is serving', () => {
  // Two exemptions, both prose rather than behaviour. Comments may name the
  // other brand - explaining why a tab strip is built per brand is the whole
  // reason the code reads. And SJ_CHANGELOG is news written for people, where
  // announcing a second front door is the entire point of the entry.
  const upToChangelog = dashboardHtml.slice(0, dashboardHtml.indexOf('const SJ_CHANGELOG'));
  assert.ok(upToChangelog.length > 0, 'SJ_CHANGELOG moved or is gone');
  const code = upToChangelog
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(
    !code.includes('Listening Party'),
    'public/index.html must not name the other brand; it reads window.__SURFACE__',
  );
});
