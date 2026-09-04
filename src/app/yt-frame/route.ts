// Johnny Outlaw, LLC — Suffering Jukebox — hosted YouTube player frame
//
// Why this exists: inside the native shell the web UI is served by Capacitor
// from `capacitor://www.sufferingjukebox.stream`. WKWebView reserves http/https
// for real network loads, so Capacitor cannot serve bundled assets over https
// (it validates the scheme and falls back) — the origin is always custom. The
// YouTube embed rejects that origin outright with error 153.
//
// So the app embeds this page instead, which IS on a real https origin. It
// owns the YT player and speaks postMessage to the app: commands in, state out.
// The app keeps a mirror of the state so its synchronous getters
// (getCurrentTime, getPlayerState, ...) keep working unchanged.
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ALLOWED_ID = /^[A-Za-z0-9_-]{6,20}$/;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("v") || "";
  const videoId = ALLOWED_ID.test(raw) ? raw : "";
  const autoplay = req.nextUrl.searchParams.get("autoplay") === "0" ? 0 : 1;

  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Suffering Jukebox player</title>
<style>
  html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden}
  #p,iframe{width:100%;height:100%;border:0;display:block}
</style>
</head><body>
<div id="p"></div>
<script>
(function () {
  var VIDEO_ID = ${JSON.stringify(videoId)};
  var AUTOPLAY = ${autoplay};
  var player = null, ready = false;
  var pending = [];

  // Only ever talk to whoever framed us. The parent validates by event.source,
  // so '*' here is safe and avoids hardcoding the app's custom-scheme origin.
  function toParent(msg) {
    try { parent.postMessage(Object.assign({ sj: 'frame' }, msg), '*'); } catch (e) {}
  }

  function pushState() {
    if (!player || !ready) return;
    var d = {};
    try { d = player.getVideoData() || {}; } catch (e) {}
    toParent({ type: 'state', state: {
      t:    safe(function () { return player.getCurrentTime(); }, 0),
      d:    safe(function () { return player.getDuration(); }, 0),
      s:    safe(function () { return player.getPlayerState(); }, -1),
      vol:  safe(function () { return player.getVolume(); }, 100),
      muted: safe(function () { return !!player.isMuted(); }, false),
      data: { title: d.title || '', video_id: d.video_id || '' }
    }});
  }

  function safe(fn, fallback) {
    try { var v = fn(); return (typeof v === 'number' && isFinite(v)) ? v : (v == null ? fallback : v); }
    catch (e) { return fallback; }
  }

  // A fixed vocabulary - never dispatch an arbitrary property name from a message.
  var COMMANDS = {
    loadVideoById: 1, cueVideoById: 1, seekTo: 1, playVideo: 1, pauseVideo: 1,
    setVolume: 1, mute: 1, unMute: 1, stopVideo: 1
  };

  function run(method, args) {
    if (!COMMANDS[method]) return;
    if (!player || !ready) { pending.push([method, args]); return; }
    try { player[method].apply(player, args || []); } catch (e) {}
    pushState();
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.sj !== 'cmd' || typeof m.method !== 'string') return;
    run(m.method, Array.isArray(m.args) ? m.args : []);
  });

  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('p', {
      videoId: VIDEO_ID,
      playerVars: { autoplay: AUTOPLAY, rel: 0, playsinline: 1, enablejsapi: 1, controls: 1 },
      events: {
        onReady: function () {
          ready = true;
          for (var i = 0; i < pending.length; i++) run(pending[i][0], pending[i][1]);
          pending = [];
          toParent({ type: 'ready' });
          pushState();
        },
        onStateChange: function (ev) {
          toParent({ type: 'stateChange', data: ev.data });
          pushState();
        },
        onError: function (ev) { toParent({ type: 'error', data: ev.data }); }
      }
    });
    // Position drives the parent's progress UI and its hand-off to background
    // audio, so it has to keep flowing even while the state is unchanged.
    setInterval(pushState, 250);
  };

  var s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();
</script>
</body></html>`;

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Must stay framable by the app shell.
      "cache-control": "public, max-age=300",
    },
  });
}
