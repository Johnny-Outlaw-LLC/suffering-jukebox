// Light and dark toggle for the Listening Party static pages. Same key as /help.
(function () {
  var key = 'sj-theme';
  var btn = document.getElementById('themeToggle');
  try { if (localStorage.getItem(key) === 'light') document.body.classList.add('light'); } catch (_) {}
  function paint() { if (btn) btn.textContent = document.body.classList.contains('light') ? '☾' : '☀'; }
  paint();
  if (btn) btn.onclick = function () {
    document.body.classList.toggle('light');
    try { localStorage.setItem(key, document.body.classList.contains('light') ? 'light' : 'dark'); } catch (_) {}
    paint();
  };
})();
