import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('a tap inside the artist break fly-out keeps its selected artist', () => {
  const from = html.indexOf('let _lamArtistId = null;');
  const to = html.indexOf('function lamOpen(', from);
  assert.ok(from > 0 && to > from, 'could not locate the artist menu close handlers');

  const flyoutTarget = {};
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (id === 'lam-menu') return { contains: () => false };
        if (id === 'sjm-submenu') return { contains: target => target === flyoutTarget };
        return null;
      },
      removeEventListener() {},
    },
    window: { removeEventListener() {} },
    sjmCloseSubmenu() {},
  });
  vm.runInContext(
    html.slice(from, to) + '\nglobalThis.__artistId = () => _lamArtistId; globalThis.__setArtistId = id => { _lamArtistId = id; };',
    context,
  );
  context.__setArtistId('artist-1');
  context._lamOutside({ target: flyoutTarget });
  assert.equal(context.__artistId(), 'artist-1');
});

test('artist break menu only presents a permanent Never play action', async () => {
  const from = html.indexOf('function lamOpenBreak()');
  const to = html.indexOf('async function lamSetBreak(', from);
  assert.ok(from > 0 && to > from, 'could not locate the artist break menu');

  let rendered = '';
  const context = vm.createContext({
    _lamArtistId: 'artist-1',
    _sjmHeader: title => title + '|',
    SJ_BREAK_OPTS: [{ days: 7, label: '1 week' }],
    YTP_DECK_ICONS: { pause: 'Ⅱ' },
    sjmOpenSubmenu: (_name, markup) => { rendered = markup; },
    lamArtistTrackIds: async () => [],
    document: { getElementById: () => null },
    isTrackOnBreak: () => false,
    sjmPositionSubmenu() {},
    console,
  });
  vm.runInContext(html.slice(from, to), context);
  context.lamOpenBreak();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(rendered, /Never play these again/);
  assert.doesNotMatch(rendered, /Play these again now/);
});

test('the retired Play these again now action is absent from the app', () => {
  assert.doesNotMatch(html, /Play these again now/);
  assert.doesNotMatch(html, /lamClearBreak|almClearBreak/);
});
