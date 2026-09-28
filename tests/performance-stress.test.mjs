// @suite performance-stress
// @area Performance
// @covers playlistChartRefreshPlayback, Now Playing long-queue repaint path
// Stress tests for the work that runs while a long Now Playing queue is live.
// This deliberately uses a small DOM double rather than a browser: the useful
// assertion is that playback updates do not scan every rendered cell. A real
// browser benchmark would be noisy and would make every build depend on a
// downloaded browser binary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function cell(index) {
  const classes = new Set();
  return {
    getAttribute(name) {
      if (name === 'data-pc-index') return String(index);
      if (name === 'data-pc-track') return `track-${index}`;
      return null;
    },
    classList: {
      contains(name) { return classes.has(name); },
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
  };
}

function hostWithCells(count) {
  const cells = Array.from({ length: count }, (_, i) => cell(i));
  const byIndex = new Map(cells.map((el) => [Number(el.getAttribute('data-pc-index')), el]));
  const selectors = [];
  return {
    selectors,
    querySelectorAll(selector) {
      selectors.push(selector);
      const exact = selector.match(/data-pc-index="(-?\d+)"/);
      if (exact) return byIndex.has(Number(exact[1])) ? [byIndex.get(Number(exact[1]))] : [];
      return cells;
    },
  };
}

function refreshFixture({ rendered = 5000, current = 1, previous = 0 } = {}) {
  const grid = hostWithCells(rendered);
  const state = { current, syncs: 0, paints: 0 };
  const scope = {
    viewMode: 'playlistchart',
    document: {
      getElementById(id) {
        return id === 'pl-wall-grid' ? grid : null;
      },
    },
    playlistChartCurrentCellIndex: () => state.current,
    isTrackBlocked: () => false,
    playlistChartSyncToCurrent: () => { state.syncs++; },
    playlistChartPaintTransport: () => { state.paints++; },
    _plWallLastCurrentIdx: previous,
  };
  const { playlistChartRefreshPlayback } = loadHtmlFnsInScope(
    ['playlistChartRefreshPlayback'],
    scope,
  );
  return { grid, state, refresh: playlistChartRefreshPlayback };
}

test('long-queue playback stress stays constant-size per repaint', () => {
  const fixture = refreshFixture();
  const updates = 1000;

  for (let i = 1; i <= updates; i++) {
    fixture.state.current = i;
    fixture.refresh();
  }

  assert.equal(fixture.grid.selectors.length, updates * 2);
  assert.ok(fixture.grid.selectors.every((s) => s.includes('data-pc-index="')));
  assert.equal(fixture.state.syncs, updates);
  assert.equal(fixture.state.paints, updates);
});

test('unchanged playback does not rescan or resync the wall', () => {
  const fixture = refreshFixture({ current: 77, previous: 77 });

  fixture.refresh();

  assert.deepEqual(fixture.grid.selectors, ['.pl-wall-cell[data-pc-index="77"]']);
  assert.equal(fixture.state.syncs, 0);
  assert.equal(fixture.state.paints, 1);
});

test('full repaint remains available for blocked-track changes', () => {
  const fixture = refreshFixture({ rendered: 5000 });

  fixture.refresh({ full: true });

  assert.deepEqual(fixture.grid.selectors, ['.pl-wall-cell[data-pc-index]']);
  assert.equal(fixture.state.syncs, 1);
  assert.equal(fixture.state.paints, 1);
});

test('scrolling a long cover wall measures only nearby placeholders', () => {
  let measured = 0;
  let upgraded = 0;
  const children = Array.from({ length: 5000 }, (_, i) => ({
    getBoundingClientRect() {
      measured++;
      const top = Math.floor(i / 10) * 100;
      return { top, bottom: top + 100 };
    },
    hasAttribute(name) { return name === 'data-pc-ph'; },
    getAttribute(name) { return name === 'data-pc-index' ? String(i) : null; },
    set outerHTML(_html) { upgraded++; },
  }));
  const host = { children, isConnected: true };
  const scroll = { getBoundingClientRect: () => ({ top: 25000, bottom: 25500 }) };
  const scope = {
    _plFillState: {
      host, isDetail: false, q: Array.from({ length: 5000 }), curIdx: 0,
    },
    document: { getElementById: () => scroll },
    plWallCellHTML: () => '<div></div>',
  };
  const { plWallUpgradeVisiblePlaceholders } = loadHtmlFnsInScope(
    ['plWallUpgradeVisiblePlaceholders'], scope,
  );

  plWallUpgradeVisiblePlaceholders();

  assert.ok(upgraded > 0);
  assert.ok(upgraded < 300);
  assert.ok(measured < 350, `measured ${measured} of 5000 cells`);
});

test('bulk personal play counts refresh a long wall once', async () => {
  const rows = Array.from({ length: 510 }, (_, i) => ({
    track_id: `track-${i}`, plays: i + 1, last_played: '2026-09-19',
  }));
  let wallRefreshes = 0;
  let counterLookups = 0;
  const inlineCounter = { getAttribute: () => 'track-17', style: {}, textContent: '' };
  const cardCounter = { id: 'sc-myplays-track-42', textContent: '' };
  const scope = {
    googleUser: { email: 'listener@example.test' },
    viewMode: 'playlistchart',
    myInAppPlays: {},
    myLastPlayed: {},
    dbRpcAuth: async () => rows,
    document: {
      querySelectorAll(selector) {
        counterLookups++;
        if (selector === '[data-myplays]') return [inlineCounter];
        if (selector === '[id^="sc-myplays-"]') return [cardCounter];
        return [];
      },
      getElementById() { return null; },
    },
    fmtV: n => String(n),
    sjCarPushShuffleProfile() {},
    plWallRefreshStats() { wallRefreshes++; },
  };
  const { loadMyPlayCounts } = loadHtmlFnsInScope(['loadMyPlayCounts'], scope);

  await loadMyPlayCounts();

  assert.equal(counterLookups, 2);
  assert.equal(inlineCounter.textContent, '18');
  assert.equal(cardCounter.textContent, '43');
  assert.equal(wallRefreshes, 1);
});

test('track menu library checks never feed guarded promises back into a render loop', async () => {
  let artistReads = 0;
  let libraryReads = 0;
  let renders = 0;
  const scope = {
    googleUser: { email: 'listener@example.test' },
    _myArtistIds: null,
    _esLibTrackIds: null,
    sjLandingRowFor: () => null,
    oaIsMine: () => false,
    ensureMyArtistIds: async () => { artistReads++; },
    esEnsureLibrary: async () => { libraryReads++; },
    sjmRenderRoot: () => { renders++; },
  };
  const { sjmAlreadyInMyLibrary } = loadHtmlFnsInScope(['sjmAlreadyInMyLibrary'], scope);

  for (let i = 0; i < 20; i++) sjmAlreadyInMyLibrary('artist-1', 'track-1');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(artistReads, 20);
  assert.equal(libraryReads, 20);
  assert.equal(renders, 0, 'resolved loader guards must not schedule another menu render');
});

test('My Artists refresh repaints an open track menu once when the real request settles', async () => {
  const request = deferred();
  let renders = 0;
  const scope = {
    googleUser: { email: 'listener@example.test' },
    _myArtistIds: null,
    _myArtistIdsLoading: false,
    isLandingMode: false,
    artistScope: () => 'all',
    renderLanding() {},
    _sjmTrackId: 'track-1',
    document: { getElementById: id => id === 'sjm-menu' ? {} : null },
    sjmRenderRoot: () => { renders++; },
    mjRequest: () => request.promise,
    console,
  };
  const { ensureMyArtistIds } = loadHtmlFnsInScope(['ensureMyArtistIds'], scope);

  const first = ensureMyArtistIds();
  await ensureMyArtistIds(); // guarded call resolves, but owns no repaint callback
  await Promise.resolve();
  assert.equal(renders, 0);

  request.resolve({ ok: true, artistIds: ['artist-1'] });
  await first;
  assert.equal(renders, 1);
  assert.deepEqual([...scope._myArtistIds], ['artist-1']);
});
