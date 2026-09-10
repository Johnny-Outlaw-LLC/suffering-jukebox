// @suite Listening history card
// @area Analytics
// @covers sjLhStat, sjLhIcon, sjLhSparkline, sjLhRenderHTML, sjLhAgo, sjLhDur in public/index.html
//
// The card is the one place outside the player that names a thumb and a heart,
// and it used to draw them as emoji - which meant the site showed two different
// thumbs depending on which screen you were on, and the platform decided what
// they looked like. It reads the player's own constants now, so the two cannot
// drift. "Playback reaction" is the term /help publishes for a heart, and the
// card has to use the same word the help page teaches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, dashboardHtml, readRepoFile } from './_load.mjs';

// The two marks, lifted from the page the way the card lifts them.
const THUMB_PATH = 'M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56';
const HEART_PATH = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0';

const escHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function card(over = {}) {
  const scope = {
    escHtml,
    Math,
    Date,
    Number,
    Array,
    Object,
    _SVG_TH_UP: `<svg><path d="${THUMB_PATH}"/></svg>`,
    SJ_REACTION_ICONS: { heart: `<svg><path d="${HEART_PATH}"/></svg>` },
    sjLhWhere: () => ({ label: 'Jukebox', cls: '' }),
    sjLhShuffleHTML: () => '<div class="sj-lh-why">SHUFFLE REPORT</div>',
    myLastPlayed: {},
    ...over,
  };
  const fns = loadHtmlFnsInScope(
    ['sjLhStat', 'sjLhIcon', 'sjLhSparkline', 'sjLhRenderHTML', 'sjLhAgo', 'sjLhDur'],
    scope,
  );
  return { ...fns, scope };
}

const DAY = 86400000;

/** n plays, most recent first, spread a few days apart. */
function plays(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    played_at: new Date(Date.UTC(2026, 8, 1) - (i * 9 + 3) * DAY).toISOString(),
    rating_before: 1,
    rating_after: 1,
    hearts: 0,
    reactions: {},
    ms: 117000,
    source: 'jukebox',
    ...over,
  }));
}

const summary = (over = {}) => ({
  plays: 9, plays_7d: 1, plays_30d: 3, hearts_total: 2, rating_now: 1, ...over,
});

/** Each stat tile as "value | label", the way it reads on screen. */
function tiles(html) {
  const out = [];
  const re = /<div class="sj-lh-stat[^"]*">([\s\S]*?)<\/div>\s*(?=<div class="sj-lh-stat|<\/div>)/g;
  let m;
  while ((m = re.exec(html))) {
    const chunk = m[1];
    const label = (chunk.match(/<span>([^<]*)<\/span>\s*$/) || [])[1] || '';
    const value = (chunk.match(/<b>([\s\S]*?)<\/b>/) || ['', ''])[1]
      .replace(/<[^>]*>/g, '').trim();
    out.push(`${value} | ${label}`);
  }
  return out;
}

// ── The two marks come from the player, not from an emoji font ────────────

test('the icon constants the card reads are the ones the player draws', () => {
  // If either of these moves, the card silently falls back to nothing.
  assert.ok(dashboardHtml.includes(THUMB_PATH), '_SVG_TH_UP still draws this thumb');
  assert.ok(dashboardHtml.includes(HEART_PATH), 'SJ_REACTION_ICONS.heart still draws this heart');
  const icon = dashboardHtml.slice(dashboardHtml.indexOf('function sjLhIcon(kind, on)'));
  assert.match(icon.slice(0, 400), /SJ_REACTION_ICONS\.heart/);
  assert.match(icon.slice(0, 400), /_SVG_TH_UP/);
});

test('the card draws the dock thumb and the dock heart, and no emoji', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary(), plays(9, { hearts: 1 }));
  assert.ok(html.includes(THUMB_PATH), 'the thumb is the player svg');
  assert.ok(html.includes(HEART_PATH), 'the heart is the player svg');
  assert.doesNotMatch(html, /\u{1F44D}/u, 'no emoji thumb');
  assert.doesNotMatch(html, /♥/, 'no typographic heart');
});

test('a mark that has not been given is drawn switched off, not left out', () => {
  const { sjLhIcon } = card();
  assert.match(sjLhIcon('up', true), /class="sj-lh-ic up"/);
  assert.match(sjLhIcon('up', false), /class="sj-lh-ic off"/);
  assert.match(sjLhIcon('heart', true), /class="sj-lh-ic heart"/);
  assert.ok(sjLhIcon('heart', false).includes(HEART_PATH), 'still the same shape when off');
});

// ── The word the help page publishes ──────────────────────────────────────

test('hearts are called playback reactions, the term /help teaches', () => {
  const help = readRepoFile('public/help/index.html');
  assert.match(help, /playback reaction/,
    'if /help renames this, the card has to be renamed with it');
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary(), plays(9));
  assert.match(html, /playback reactions<\/span>/);
  assert.doesNotMatch(html, />hearts<\/span>/, 'the old label is gone');
});

test('one reaction is a playback reaction, not playback reactions', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary({ hearts_total: 1 }), plays(9));
  assert.match(html, /playback reaction<\/span>/);
  assert.doesNotMatch(html, /playback reactions<\/span>/);
});

test('the top bar reads as five counters and a shape', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary(), plays(9));
  assert.deepStrictEqual(tiles(html), [
    '9 | plays',
    '1 | last 7 days',
    '3 | last 30 days',
    '2 | playback reactions',
    ' | your rating',
    ' | listens over time &middot; Jun 2026 - Aug 2026',
  ]);
});

test('an unrated song says so rather than showing a lit thumb', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary({ rating_now: 0 }), plays(9));
  assert.match(html, /class="sj-lh-ic off"/);
  assert.match(html, /–<\/b>/, 'a dash stands in for the count');
});

// ── Listens over time ─────────────────────────────────────────────────────

test('the sparkline is drawn from the plays listed underneath it', () => {
  const { sjLhSparkline } = card();
  const svg = sjLhSparkline(plays(9));
  assert.match(svg, /class="sj-lh-spark"/);
  const bars = svg.match(/<rect /g) || [];
  assert.ok(bars.length >= 1 && bars.length <= 28, `drew ${bars.length} bars`);
  assert.match(svg, /listens over time/);
});

test('every bar sits inside the box, and the busiest one fills it', () => {
  // A bar taller than the viewBox is clipped, and one that never reaches the
  // top makes a busy month look quiet.
  const { sjLhSparkline } = card();
  const busy = [...plays(4), ...Array.from({ length: 12 }, () => ({
    played_at: new Date(Date.UTC(2026, 8, 1)).toISOString(),
  }))];
  const svg = sjLhSparkline(busy);
  const rects = [...svg.matchAll(/y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)]
    .map(([, y, h]) => ({ y: +y, h: +h }));
  assert.ok(rects.length > 0);
  for (const r of rects) {
    assert.ok(r.y >= 0 && r.y + r.h <= 26.01, `bar at ${r.y} is ${r.h} tall`);
    assert.ok(r.h >= 2, 'a bar that is there has to be visible');
  }
  assert.ok(rects.some((r) => Math.abs(r.h - 26) < 0.01), 'the peak fills the box');
});

test('one play is not a shape, so nothing is drawn', () => {
  const { sjLhSparkline, sjLhRenderHTML } = card();
  assert.equal(sjLhSparkline(plays(1)), '');
  assert.equal(sjLhSparkline([]), '');
  assert.doesNotMatch(sjLhRenderHTML('t1', summary({ plays: 1 }), plays(1)), /sj-lh-spark/);
});

test('plays all on one day still draw, and say one month', () => {
  const { sjLhSparkline } = card();
  const same = new Date(Date.UTC(2026, 7, 4)).toISOString();
  const svg = sjLhSparkline([{ played_at: same }, { played_at: same }, { played_at: same }]);
  assert.match(svg, /<rect /);
  assert.match(svg, /listens over time &middot; Aug 2026<\/span>/, 'not "Aug 2026 - Aug 2026"');
});

test('a play with an unreadable date cannot break the shape', () => {
  const { sjLhSparkline } = card();
  const svg = sjLhSparkline([...plays(4), { played_at: 'not a date' }, { played_at: null }]);
  assert.match(svg, /<rect /);
  assert.doesNotMatch(svg, /NaN/);
});

// ── What sits where ───────────────────────────────────────────────────────

test('the shuffle report is the last thing on the card', () => {
  // It answers "why am I hearing this", which is interesting after the history,
  // not in front of it.
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary(), plays(9));
  const why = html.indexOf('sj-lh-why');
  assert.ok(why > html.indexOf('sj-lh-stats'), 'below the counters');
  assert.ok(why > html.indexOf('sj-lh-list'), 'below the list of plays');
  assert.ok(why > html.lastIndexOf('sj-lh-note'), 'below the footnotes');
});

test('the hearts reconciliation footnote is gone', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary({ hearts_total: 9 }), plays(9));
  assert.doesNotMatch(html, /hearts in total/);
  assert.doesNotMatch(html, /device that was not logging plays/);
});

test('the footnotes that earn their place are still there', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary({ plays: 400 }), plays(9));
  assert.match(html, /Showing the 9 most recent of 400 plays\./);
  assert.match(html, /capped at 30 minutes/);
});

test('a play row names the reaction the same way the counter does', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary(), plays(1, { hearts: 2 }));
  assert.match(html, /2 reactions<\/span>/);
  const one = sjLhRenderHTML('t1', summary(), plays(1, { hearts: 1 }));
  assert.match(one, /1 reaction<\/span>/);
});

test('a thumb given during a play is marked with the player thumb', () => {
  const { sjLhRenderHTML } = card();
  const given = sjLhRenderHTML('t1', summary(), plays(1, { rating_before: 0, rating_after: 1 }));
  assert.match(given, /sj-lh-tag up/);
  assert.ok(given.includes(THUMB_PATH));
  const taken = sjLhRenderHTML('t1', summary(), plays(1, { rating_before: 1, rating_after: 0 }));
  assert.match(taken, /thumbs up taken back/);
});

test('a song nobody has played says so', () => {
  const { sjLhRenderHTML } = card();
  const html = sjLhRenderHTML('t1', summary({ plays: 0, hearts_total: 0, rating_now: 0 }), []);
  assert.match(html, /No plays recorded yet/);
  assert.doesNotMatch(html, /Showing the/);
});

// ── The small helpers underneath ──────────────────────────────────────────

test('how long ago reads in the largest unit that still means something', () => {
  const { sjLhAgo } = card();
  const now = Date.now();
  assert.match(sjLhAgo(new Date(now - 2 * DAY).toISOString()), /^2 days ago$/);
  assert.match(sjLhAgo(new Date(now - 1 * DAY).toISOString()), /^1 day ago$/);
  assert.match(sjLhAgo(new Date(now - 60 * DAY).toISOString()), /months ago$/);
  assert.match(sjLhAgo(new Date(now - 800 * DAY).toISOString()), /years ago$/);
});

test('a play length reads as minutes and seconds', () => {
  const { sjLhDur } = card();
  assert.equal(sjLhDur(117000), '1:57');
  assert.equal(sjLhDur(5000), '0:05');
  assert.equal(sjLhDur(0), '0:00');
});
