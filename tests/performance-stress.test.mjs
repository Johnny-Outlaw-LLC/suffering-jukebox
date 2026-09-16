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
