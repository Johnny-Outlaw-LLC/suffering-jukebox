// @suite Lyric sync editor
// @area Lyrics
// @covers Editing, adding and removing lines in the sync window, and following the song
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, dashboardHtml } from './_load.mjs';

const fns = loadHtmlFnsInScope(['lsyIsTimedLine', 'lsyLinesFromText', 'lsyRebuildText', 'lsyFmt', 'lsyBuildLrc'], {});
const SRC = '[Verse 1]\nIs a body just for taxing?\nIs the skin for ticketing?\n\n[Chorus]\nSingly, the parent\nLies face down';

test('only sung lines are offered for timing, each remembering its source line', () => {
  const lines = fns.lsyLinesFromText(SRC);
  assert.deepEqual(lines.map(l => l.text), ['Is a body just for taxing?', 'Is the skin for ticketing?', 'Singly, the parent', 'Lies face down']);
  assert.deepEqual(lines.map(l => l.si), [1, 2, 5, 6]);
});

test('unchanged lines rebuild to the same lyrics', () => {
  assert.equal(fns.lsyRebuildText(SRC, fns.lsyLinesFromText(SRC)), SRC);
});

test('an edited line keeps its place, stanza breaks and headers', () => {
  const lines = fns.lsyLinesFromText(SRC);
  lines[1].text = 'Is the skin just for ticketing?';
  assert.equal(fns.lsyRebuildText(SRC, lines),
    '[Verse 1]\nIs a body just for taxing?\nIs the skin just for ticketing?\n\n[Chorus]\nSingly, the parent\nLies face down');
});

test('a removed line disappears and a new line follows the one it was added after', () => {
  const lines = fns.lsyLinesFromText(SRC);
  lines.splice(2, 1); // remove "Singly, the parent"
  lines.splice(1, 0, { text: 'A brand new line', t: null, si: null }); // after line 1
  assert.equal(fns.lsyRebuildText(SRC, lines),
    '[Verse 1]\nIs a body just for taxing?\nA brand new line\nIs the skin for ticketing?\n\n[Chorus]\nLies face down');
});

test('a song with no words yet builds from the typed lines', () => {
  assert.equal(fns.lsyRebuildText('', [{ text: 'First', si: null }, { text: 'Second', si: null }]), 'First\nSecond');
});

test('blank typed lines are dropped rather than saved', () => {
  const lines = fns.lsyLinesFromText(SRC);
  lines.push({ text: '   ', t: null, si: null });
  assert.equal(fns.lsyRebuildText(SRC, lines), SRC);
});

test('the timing skips empty lines and keeps the order rule', () => {
  globalThis._lsy = { lines: [{ text: 'One', t: 1 }, { text: '', t: null }, { text: 'Two', t: 2.5 }] };
  const scoped = loadHtmlFnsInScope(['lsyFmt', 'lsyBuildLrc'], { _lsy: globalThis._lsy });
  assert.equal(scoped.lsyBuildLrc(), '[00:01.00]One\n[00:02.50]Two');
  delete globalThis._lsy;
});

test('the window has a draggable position bar and a play button that becomes pause', () => {
  const html = dashboardHtml;
  assert.match(html, /id="lsySeek"[^>]*oninput="lsyScrubInput/);
  assert.match(html, /id="lsyPlayBtn"/);
  assert.match(html, /btn\.textContent !== want/);
});

test('both lyric editors ask before a song change drops unsaved work', () => {
  const html = dashboardHtml;
  assert.match(html, /async function lsyFollowSong\(\)[\s\S]{0,900}cancelLabel: 'Discard'/);
  assert.match(html, /async function ytpUpdateLyrics\(trackId\)[\s\S]{0,1500}cancelLabel: 'Discard'/);
});

test('a confirmation sits above every modal, including the sync window', () => {
  const html = dashboardHtml;
  // z-index of the first CSS rule that starts with this selector.
  const z = sel => {
    let at = 0;
    for (;;) {
      at = html.indexOf(sel, at);
      if (at < 0) return NaN;
      const rule = html.slice(at + sel.length, html.indexOf('}', at));
      const m = /^\s*\{[^]*?z-index:\s*(\d+)/.exec(rule);
      if (m) return Number(m[1]);
      at += sel.length;
    }
  };
  const confirm = z('.sj-confirm-overlay');
  assert.ok(confirm > z('#lsyOverlay'), `confirm ${confirm} must beat the sync window ${z('#lsyOverlay')}`);
  const modals = [...html.matchAll(/(?:overlay|modal)[^{};]*\{[^}]*?z-index:\s*(\d+)/gi)].map(m => +m[1]).filter(n => n !== confirm);
  assert.ok(confirm > Math.max(...modals), `confirm ${confirm} must beat every modal (highest ${Math.max(...modals)})`);
});
