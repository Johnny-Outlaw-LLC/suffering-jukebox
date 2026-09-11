// @suite Listening Party welcome hero
// @area Listening Party
// @covers public/index.html lph*
// @covers supabase/migrations/20260910160000_featured_playlists.sql
//
// Listening Party leads with playlists, so its front door has to hand the
// visitor one. Three picks come from jukebox.featured_playlists(): the newest
// public playlist, the one whose songs have the most YouTube views, and the one
// played most on our own sites in the last 30 days.
//
// The hero belongs to one brand. Everything here also pins that Suffering
// Jukebox never renders it - it opens on a wall of artists and needs no hero.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs, loadHtmlFnsInScope, readRepoFile } from './_load.mjs';

const surface = loadTs('src/lib/surface.ts');
const SJ = surface.SURFACES.sj;
const LP = surface.SURFACES.lp;

const indexHtml = readRepoFile('public/index.html');

/** The LPH_PICKS table out of the dashboard, so the test cannot invent one. */
function picksTable() {
  const at = indexHtml.indexOf('const LPH_PICKS = {');
  assert.ok(at >= 0, 'LPH_PICKS is gone from public/index.html');
  const end = indexHtml.indexOf('};', at);
  const literal = indexHtml.slice(at + 'const LPH_PICKS = '.length, end + 1);
  return new Function(`return (${literal});`)();
}

function hero(brand, state = {}) {
  const scope = {
    SJ_BRAND: surface.publicSurface(brand),
    LPH_PICKS: picksTable(),
    _lphPicks: state.picks ?? null,
    _lphLoading: state.loading ?? false,
    _lphFailed: state.failed ?? false,
    lphLoad() {
      scope.loadCalled = true;
    },
    loadCalled: false,
  };
  const fns = loadHtmlFnsInScope(
    ['lphCompact', 'lphAgo', 'lphStatFor', 'lphCardHTML', 'lphHeroHTML', 'lphOpen'],
    scope
  );
  return { ...fns, scope };
}

const row = (over = {}) => ({
  pick: 'new',
  playlist_id: '11111111-1111-1111-1111-111111111111',
  name: 'Early Shellac',
  slug: null,
  user_name: 'Johnny Outlaw',
  track_count: 28,
  created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  yt_views: 2925057,
  plays_30d: 15,
  art_urls: ['a.jpg', 'b.jpg', 'c.jpg'],
  ...over,
});

// ── Whose front door this is ──────────────────────────────────────────────

test('only the playlist-led brand has a welcome hero', () => {
  assert.equal(LP.features.welcomeHero, true);
  assert.equal(SJ.features.welcomeHero, false);
});

test('Suffering Jukebox renders nothing and does not even fetch the picks', () => {
  const h = hero(SJ);
  assert.equal(h.lphHeroHTML(), '');
  assert.equal(h.scope.loadCalled, false, 'SJ asked the server for picks it will not show');
});

test('the hero loads its picks once, on first render', () => {
  const h = hero(LP);
  h.lphHeroHTML();
  assert.equal(h.scope.loadCalled, true);

  const loaded = hero(LP, { picks: [row()] });
  loaded.lphHeroHTML();
  assert.equal(loaded.scope.loadCalled, false, 'refetched picks it already had');
});

// ── The collage ───────────────────────────────────────────────────────────

test('a collage is 1, 2 or 4 tiles - never 3', () => {
  // aspect-ratio pins the box, not the grid inside it. Three tiles in a two
  // column grid make two rows, and before this the second row pushed the
  // collage down through the card and over the title.
  const h = hero(LP);
  const tiles = (n) =>
    (h.lphCardHTML(row({ art_urls: Array.from({ length: n }, (_, i) => `${i}.jpg`) })).match(
      /<img /g
    ) || []).length;
  assert.equal(tiles(0), 0);
  assert.equal(tiles(1), 1);
  assert.equal(tiles(2), 2);
  assert.equal(tiles(3), 2, 'three tiles would leave a hole in the grid');
  assert.equal(tiles(4), 4);
  assert.equal(tiles(9), 4);
});

test('the collage class states its own shape, so the CSS can size the rows', () => {
  const h = hero(LP);
  for (const [n, cls] of [[1, 'n1'], [2, 'n2'], [3, 'n2'], [4, 'n4']]) {
    const html = h.lphCardHTML(row({ art_urls: Array.from({ length: n }, (_, i) => `${i}.jpg`) }));
    assert.ok(html.includes(`lph-art ${cls}`), `${n} tiles should render as ${cls}`);
  }
  // A playlist whose albums have no art still gets a card, not a broken one.
  assert.ok(h.lphCardHTML(row({ art_urls: [] })).includes('lph-art n1'));
});

test('every shape the card can emit is sized in the stylesheet', () => {
  for (const cls of ['n1', 'n2']) {
    assert.ok(indexHtml.includes(`.lph-art.${cls}`), `.lph-art.${cls} has no rule`);
  }
  // n4 is the default 2x2 declared on .lph-art itself.
  assert.ok(/\.lph-art \{[^}]*grid-template-rows:1fr 1fr/s.test(indexHtml));
  assert.ok(/\.lph-art \{[^}]*overflow:hidden/s.test(indexHtml), 'the collage must clip');
});

// ── What each pick says about itself ──────────────────────────────────────

test('each pick reports the number it was chosen for', () => {
  const h = hero(LP);
  assert.match(h.lphStatFor(row({ pick: 'youtube', yt_views: 33676157953 })), /on YouTube$/);
  assert.match(h.lphStatFor(row({ pick: 'hot', plays_30d: 318 })), /here in 30 days$/);
  assert.match(h.lphStatFor(row({ pick: 'new' })), /^added /);
});

test('a pick the server can return always has a badge and a button', () => {
  // The three names are the function's own contract; a fourth added to the SQL
  // without a label here would render "Featured / Play it" and look like a bug.
  assert.deepStrictEqual(Object.keys(picksTable()).sort(), ['hot', 'new', 'youtube']);
  const sql = readRepoFile('supabase/migrations/20260910160000_featured_playlists.sql');
  for (const pick of Object.keys(picksTable())) {
    assert.ok(sql.includes(`'${pick}'`), `the SQL never returns pick "${pick}"`);
  }
});

test('big numbers are shortened, small ones are left alone', () => {
  const { lphCompact } = hero(LP);
  assert.equal(lphCompact(0), '0');
  assert.equal(lphCompact(318), '318');
  assert.equal(lphCompact(2925057), '2.9M');
  assert.equal(lphCompact(33676157953), '34B');
  assert.equal(lphCompact(1500), '1.5K');
  assert.equal(lphCompact(15000), '15K');
});

test('"just added" is worded in days, not a timestamp', () => {
  const { lphAgo } = hero(LP);
  const ago = (d) => lphAgo(new Date(Date.now() - d * 86400000).toISOString());
  assert.equal(ago(0), 'added today');
  assert.equal(ago(1), 'added yesterday');
  assert.equal(ago(5), 'added 5 days ago');
  assert.match(ago(70), /^added 2 months ago$/);
  assert.equal(lphAgo('not a date'), '');
});

// ── The page it renders on ────────────────────────────────────────────────

test('the featured strip loads even before its picks arrive', () => {
  // A first paint with no data must still show the section, and a failed fetch
  // must not leave the page empty.
  for (const state of [{ picks: null }, { picks: [], failed: true }]) {
    const html = hero(LP, state).lphHeroHTML();
    assert.ok(html.includes('lph'), 'no featured section');
    assert.ok(!html.includes('Put something on'), 'welcome blurb was removed');
    assert.ok(!html.includes('lph-steps'), 'how-to steps were removed');
    assert.ok(!html.includes('undefined'));
  }
  // Loading shows placeholders; a failure shows none rather than empty frames.
  assert.ok(hero(LP, { picks: null }).lphHeroHTML().includes('lph-skel'));
  assert.ok(!hero(LP, { picks: [], failed: true }).lphHeroHTML().includes('lph-skel'));
});

test('a card carries the playlist name, size and credit', () => {
  const html = hero(LP).lphCardHTML(row());
  assert.ok(html.includes('Early Shellac'));
  assert.ok(html.includes('28 songs'));
  assert.ok(html.includes('Johnny Outlaw'));
  assert.ok(html.includes('Just added'));
  // One song is not "1 songs".
  const one = hero(LP).lphCardHTML(row({ track_count: 1 }));
  assert.ok(one.includes('1 song '), 'singular count is wrong');
  assert.ok(!one.includes('1 songs'));
  // A playlist by nobody drops the credit rather than trailing a bare "by".
  assert.ok(!hero(LP).lphCardHTML(row({ user_name: null })).includes('· by'));
});

test('a playlist name cannot inject markup into the card', () => {
  const html = hero(LP).lphCardHTML(row({ name: '<img src=x onerror=alert(1)>' }));
  assert.ok(!html.includes('<img src=x'), 'playlist names are user input');
  assert.ok(html.includes('&lt;img'));
});

test('the hero is mounted on the Home tab and nowhere else', () => {
  // Home is the playlist-led front door; Explore Playlists is the wall.
  assert.ok(
    /function landingHomeHTML\(\)[\s\S]*?\$\{lphHeroHTML\(\)\}/.test(indexHtml),
    'the hero is not mounted on Home',
  );
  assert.ok(
    !indexHtml.includes(`landingTab === 'playlists' ? lphHeroHTML()`),
    'the hero must not also sit on Explore Playlists',
  );
  assert.equal(
    (indexHtml.match(/lphHeroHTML\(\)/g) || []).length,
    2,
    'expected the definition plus exactly one call site',
  );
});

test('clicking a card plays that playlist', () => {
  const played = [];
  const scope = {
    SJ_BRAND: surface.publicSurface(LP),
    _lphPicks: [row({ pick: 'hot', playlist_id: 'abc' })],
    playPlaylist: (id) => played.push(id),
  };
  const { lphOpen } = loadHtmlFnsInScope(['lphOpen'], scope);
  lphOpen('hot');
  assert.deepStrictEqual(played, ['abc']);
  lphOpen('nothing-by-that-name');
  assert.deepStrictEqual(played, ['abc'], 'an unknown pick must not play something else');
});

// ── The function behind it ────────────────────────────────────────────────

test('the SQL counts site plays across BOTH brands and excludes Spotify', () => {
  const sql = readRepoFile('supabase/migrations/20260910160000_featured_playlists.sql');
  // One shared play_events table is what makes "hot on our sites" one count
  // rather than a union, and an imported Spotify history is not a play here.
  assert.ok(sql.includes('jukebox.play_events'));
  assert.ok(/source, 'jukebox'\) <> 'spotify'/.test(sql), 'Spotify rows are not excluded');
  assert.ok(sql.includes("interval '30 days'"));
  assert.ok(!/union[\s\S]*play_events/i.test(sql.split('hot as')[1] || ''), 'plays should need no union');
});

test('the YouTube pick counts the primary version only', () => {
  // Summing every alternate upload would count one song several times, the
  // same trap the charts avoid with tvTop().
  const sql = readRepoFile('supabase/migrations/20260910160000_featured_playlists.sql');
  assert.ok(sql.includes('tv.is_primary'));
  assert.ok(sql.includes('coalesce(tv.is_playable, true)'));
});

test('the three picks are always three different playlists', () => {
  const sql = readRepoFile('supabase/migrations/20260910160000_featured_playlists.sql');
  assert.ok(sql.includes('id not in (select id from p_new)'));
  assert.ok(sql.includes('union all select id from p_yt'));
});

test('the function reads only public playlists, and anon may call it', () => {
  const sql = readRepoFile('supabase/migrations/20260910160000_featured_playlists.sql');
  assert.ok(sql.includes("where p.visibility = 'public'"), 'private playlists could leak');
  assert.ok(sql.includes('security definer'), 'anon cannot read play_events directly');
  assert.ok(sql.includes('grant execute on function jukebox.featured_playlists() to anon'));
  assert.ok(sql.includes('set search_path'), 'a definer function needs a pinned search_path');
});
