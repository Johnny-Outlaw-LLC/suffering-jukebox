// Progress in Add music / Create a Playlist: a status line and a bar at the
// bottom of the box, and a minimize button that keeps the work running behind a
// pill in the corner.
//
// @suite add-music-progress
// @area Import
// @covers admPct, admProgressHTML, admPaintProgress, admMinimize, admRestore, admMiniSync
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, loadHtmlFnsInScope } from './_load.mjs';

function el(id) {
  const classes = new Set();
  const child = { style: { width: '' } };
  return {
    id, textContent: '', innerHTML: '', style: { display: '' }, className: '',
    firstElementChild: child,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    parts: {},
    querySelector(sel) { return (this.parts[sel] ||= el(sel)); },
  };
}

function scopeWith(adm) {
  const els = {};
  let renders = 0;
  const scope = {
    _adm: adm,
    _admMinimized: false,
    document: { getElementById: (id) => (els[id] ||= el(id)) },
    escHtml: (s) => String(s),
    admPlural: (n, w) => n + ' ' + w + (n === 1 ? '' : 's'),
    admSelected: () => (adm?.rows || []).filter((r) => r._on),
    admRender: () => { renders++; },
    admResultsFootHTML: () => '<footer>',
  };
  return { scope, els, renders: () => renders };
}

const NAMES = ['admPct', 'admPaintBar', 'admProgressHTML', 'admPaintProgress', 'admMinimize', 'admRestore', 'admMiniSync', 'admClose'];

test('the bar fills by count, and runs indeterminate for a step with no count', () => {
  const { scope } = scopeWith(null);
  const { admPct } = loadHtmlFnsInScope(NAMES, scope);
  assert.equal(admPct({ progDone: 3, progTotal: 12 }), 25);
  assert.equal(admPct({ progDone: 12, progTotal: 12 }), 100);
  assert.equal(admPct({ progDone: 40, progTotal: 12 }), 100);
  assert.equal(admPct({ progDone: 3, progTotal: null }), null);
});

test('progress sits in the footer with a bar, and only while work is running', () => {
  const adm = { busy: true, phase: 'results', progress: 'Adding 4 of 20 to the Jukebox…', progDone: 3, progTotal: 20, rows: [] };
  const { scope } = scopeWith(adm);
  const { admProgressHTML } = loadHtmlFnsInScope(NAMES, scope);
  const html = admProgressHTML();
  assert.match(html, /id="adm-prog-t">Adding 4 of 20 to the Jukebox…</);
  assert.match(html, /class="adm-prog-bar" id="adm-prog-bar"><span style="width:15%">/);
  adm.progTotal = null;
  assert.match(admProgressHTML(), /class="adm-prog-bar ind"/);
  adm.busy = false;
  assert.equal(admProgressHTML(), '');
  // And no longer at the top of the list.
  assert.doesNotMatch(dashboardHtml, /class="adm-note" id="adm-progress"/);
  assert.match(dashboardHtml, /return admProgressHTML\(\) \+ '<span class="adm-count"/);
});

test('a progress tick repaints the bar in place instead of the whole box', () => {
  const adm = { busy: true, phase: 'results', progress: '', rows: [] };
  const { scope, els, renders } = scopeWith(adm);
  const { admPaintProgress } = loadHtmlFnsInScope(NAMES, scope);
  scope.document.getElementById('adm-prog-t');
  scope.document.getElementById('adm-prog-bar');
  admPaintProgress('Looking up 5 of 10 on YouTube…', 4, 10);
  assert.equal(els['adm-prog-t'].textContent, 'Looking up 5 of 10 on YouTube…');
  assert.equal(els['adm-prog-bar'].firstElementChild.style.width, '40%');
  assert.equal(renders(), 0);
});

test('minimize hides the box, keeps the job, and shows its progress in the pill', () => {
  const adm = { busy: true, phase: 'results', progress: 'Adding 2 of 8 to the Jukebox…', progDone: 1, progTotal: 8, rows: [], mode: 'playlist' };
  const { scope, els } = scopeWith(adm);
  const fns = loadHtmlFnsInScope(NAMES, scope);
  scope.document.getElementById('admOverlay').classList.add('open');
  fns.admMinimize();
  assert.equal(scope._admMinimized, true);
  assert.equal(scope._adm, adm, 'minimizing threw the job away');
  assert.equal(els.admOverlay.classList.contains('open'), false);
  const pill = els['adm-minibar'];
  assert.equal(pill.style.display, 'flex');
  assert.equal(pill.querySelector('.am-mini-txt').textContent, 'Adding 2 of 8 to the Jukebox…');
  assert.equal(pill.querySelector('.adm-mini-bar').firstElementChild.style.width, '13%');

  adm.busy = false;
  adm.rows = [{ _on: true }, { _on: true }];
  fns.admMiniSync();
  assert.equal(pill.className, 'done');
  assert.equal(pill.querySelector('.am-mini-txt').textContent, '2 songs ready. Tap to finish');

  fns.admRestore();
  assert.equal(scope._admMinimized, false);
  assert.equal(els.admOverlay.classList.contains('open'), true);
  assert.equal(pill.style.display, 'none');
});

test('closing while minimized takes the pill away too', () => {
  const adm = { busy: false, phase: 'results', rows: [] };
  const { scope, els } = scopeWith(adm);
  const fns = loadHtmlFnsInScope(NAMES, scope);
  fns.admMinimize();
  assert.equal(els['adm-minibar'].style.display, 'flex');
  fns.admClose();
  assert.equal(els['adm-minibar'].style.display, 'none');
});

test('the minimize button sits beside the X, and the pill exists', () => {
  assert.match(dashboardHtml, /onclick="admMinimize\(\)"[^>]*aria-label="Minimize"><svg[\s\S]{0,300}<\/svg><\/button>\s*<button class="modal-close" onclick="admClose\(\)"/);
  assert.match(dashboardHtml, /<div id="adm-minibar" onclick="admRestore\(\)"/);
});
