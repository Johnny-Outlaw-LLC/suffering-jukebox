'use strict';
// The Mini Player is a remote control. It shows what the page reports and
// sends commands back; the player itself stays in the main window.
(function () {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_ART = '../assets/icon.png';
  let state = { has: false };
  let stateAt = performance.now();
  let seeking = false;

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function livePos() {
    if (!state.has) return 0;
    const drift = state.playing ? (performance.now() - stateAt) / 1000 : 0;
    const p = state.pos + drift;
    return state.dur ? Math.min(p, state.dur) : p;
  }

  function paintProgress() {
    const seek = $('seek');
    const dur = state.has ? state.dur : 0;
    const pos = seeking ? Number(seek.value) : livePos();
    if (seek.max !== String(dur)) seek.max = String(dur);
    if (!seeking) seek.value = String(pos);
    seek.disabled = !state.has || !dur;
    seek.style.setProperty('--p', dur ? ((pos / dur) * 100).toFixed(2) + '%' : '0%');
    $('cur').textContent = clock(pos);
    $('dur').textContent = clock(dur);
  }

  function paint() {
    const has = !!state.has;
    $('title').textContent = has ? (state.title || 'Untitled') : 'Nothing playing';
    $('artist').textContent = has ? (state.artist || '') : 'Pick a song in Record Keeper';
    const art = has && state.art ? state.art : DEFAULT_ART;
    if ($('art').getAttribute('src') !== art) $('art').setAttribute('src', art);
    for (const id of ['prev', 'play', 'next']) $(id).disabled = !has;
    $('heart').disabled = !has || !state.canHeart;
    const play = $('play');
    play.title = state.playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
    $('play-ic').innerHTML = state.playing
      ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'
      : '<path d="M8 5v14l11-7z"/>';
    document.title = has ? `${state.title} - Record Keeper` : 'Record Keeper Mini Player';
    paintProgress();
  }

  $('art').addEventListener('error', () => {
    if ($('art').getAttribute('src') !== DEFAULT_ART) $('art').setAttribute('src', DEFAULT_ART);
  });

  $('play').addEventListener('click', () => {
    // Answer the click straight away; the page's next report confirms it.
    state = { ...state, pos: livePos(), playing: !state.playing };
    stateAt = performance.now();
    paint();
    window.rkMini.command('toggle');
  });
  $('next').addEventListener('click', () => window.rkMini.command('next'));
  $('prev').addEventListener('click', () => window.rkMini.command('prev'));
  $('heart').addEventListener('click', () => {
    const h = $('heart');
    h.classList.add('sent');
    setTimeout(() => h.classList.remove('sent'), 450);
    window.rkMini.command('heart');
  });
  $('expand').addEventListener('click', () => window.rkMini.expand());
  $('pin').addEventListener('click', () => {
    const on = $('pin').getAttribute('aria-pressed') !== 'true';
    paintPin(on);
    window.rkMini.setPinned(on);
  });

  const seek = $('seek');
  seek.addEventListener('pointerdown', () => { seeking = true; });
  seek.addEventListener('input', () => { seeking = true; paintProgress(); });
  seek.addEventListener('change', () => {
    const sec = Number(seek.value) || 0;
    window.rkMini.command('seek', sec);
    state = { ...state, pos: sec };
    stateAt = performance.now();
    seeking = false;
    paintProgress();
  });
  seek.addEventListener('pointerup', () => { if (seeking) setTimeout(() => { seeking = false; }, 0); });

  document.addEventListener('keydown', (e) => {
    if (e.target === seek) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); $('play').click(); }
    else if (e.key === 'ArrowRight' && e.ctrlKey) window.rkMini.command('next');
    else if (e.key === 'ArrowLeft' && e.ctrlKey) window.rkMini.command('prev');
  });

  function paintPin(on) {
    const pin = $('pin');
    pin.setAttribute('aria-pressed', on ? 'true' : 'false');
    pin.title = on ? 'Stop keeping on top' : 'Keep on top of other windows';
  }

  window.rkMini.onState((s) => {
    state = s && s.has ? s : { has: false };
    stateAt = performance.now();
    paint();
  });
  window.rkMini.onSettings((s) => paintPin(!!(s && s.alwaysOnTop)));
  setInterval(() => { if (state.playing && !seeking) paintProgress(); }, 250);
  paint();
  window.rkMini.ready();
})();
