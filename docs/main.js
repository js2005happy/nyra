/* Nyra site v4 — no framework. */
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  /* ---------- language (zh / en) ---------- */
  function applyLang(l) {
    root.setAttribute('data-lang', l);
    root.setAttribute('lang', l === 'en' ? 'en' : 'zh-CN');
    document.querySelectorAll('.lang button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.l === l)); });
    document.querySelectorAll('[data-alt-en]').forEach(function (el) {
      if (!el.dataset.altZh) el.dataset.altZh = el.getAttribute('alt') || '';
      el.setAttribute('alt', l === 'en' ? el.dataset.altEn : el.dataset.altZh);
    });
    document.querySelectorAll('[data-aria-en]').forEach(function (el) {
      if (!el.dataset.ariaZh) el.dataset.ariaZh = el.getAttribute('aria-label') || '';
      el.setAttribute('aria-label', l === 'en' ? el.dataset.ariaEn : el.dataset.ariaZh);
    });
    var t = root.dataset['title' + (l === 'en' ? 'En' : 'Zh')];
    if (t) document.title = t;
    var d = document.querySelector('meta[name="description"]');
    var dv = root.dataset['desc' + (l === 'en' ? 'En' : 'Zh')];
    if (d && dv) d.setAttribute('content', dv);
    if (window.__nyraState) window.__nyraState();
  }
  document.querySelectorAll('.lang button').forEach(function (b) {
    b.addEventListener('click', function () {
      try { localStorage.setItem('nyra-lang', b.dataset.l); } catch (e) {}
      applyLang(b.dataset.l);
    });
  });
  applyLang(root.getAttribute('data-lang') || 'zh');

  /* ---------- nav shadow ---------- */
  var nav = document.querySelector('.nav');
  function onScroll() { if (nav) nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- copy buttons ---------- */
  document.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var txt = b.dataset.copy;
      var done = function () { b.classList.add('done'); setTimeout(function () { b.classList.remove('done'); }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () {});
      else { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} ta.remove(); }
    });
  });

  /* ---------- generic tabs (download) ---------- */
  function tabs(list, onChange) {
    var btns = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    function select(i, focus) {
      btns.forEach(function (b, j) {
        var on = i === j;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        var p = document.getElementById(b.getAttribute('aria-controls'));
        if (p && p.getAttribute('role') === 'tabpanel' && !p.classList.contains('keep')) p.hidden = !on;
      });
      if (focus) btns[i].focus();
      if (onChange) onChange(i, btns[i]);
    }
    btns.forEach(function (b, i) {
      b.addEventListener('click', function () { select(i); });
      b.addEventListener('keydown', function (e) {
        var k = e.key, n = btns.length, j = -1;
        if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % n;
        else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i - 1 + n) % n;
        else if (k === 'Home') j = 0; else if (k === 'End') j = n - 1;
        if (j >= 0) { e.preventDefault(); select(j, true); }
      });
    });
    return select;
  }
  var dl = document.querySelector('[data-tabs="dl"]');
  if (dl) {
    var sel = tabs(dl);
    var ua = navigator.userAgent || '', os = 'win';
    if (/Android|iPhone|iPad|iPod/i.test(ua)) os = 'phone';
    else if (/Mac/i.test(ua)) os = 'mac';
    else if (/Linux|X11|CrOS/i.test(ua)) os = 'linux';
    var order = Array.prototype.map.call(dl.querySelectorAll('[role="tab"]'), function (b) { return b.dataset.os; });
    sel(Math.max(0, order.indexOf(os)));
    document.querySelectorAll('[data-pick]').forEach(function (a) {
      a.addEventListener('click', function () { sel(Math.max(0, order.indexOf(a.dataset.pick))); });
    });
  }

  /* ---------- steps + 团子 state ---------- */
  var states = { idle: ['空闲', 'Idle'], think: ['思考中', 'Thinking'], wait: ['等你确认', 'Waiting for you'], work: ['工作中', 'Working'], done: ['完成', 'Done'] };
  var stepList = document.querySelector('[data-tabs="steps"]');
  var mascot = document.querySelector('.mascot .bot');
  var mstate = document.querySelector('.mascot-state b');
  var cur = 'idle';
  window.__nyraState = function () {
    if (!mstate) return;
    var en = root.getAttribute('data-lang') === 'en';
    mstate.textContent = states[cur][en ? 1 : 0];
  };
  if (stepList) {
    var imgs = document.querySelectorAll('.viewer img');
    tabs(stepList, function (i, b) {
      imgs.forEach(function (im, j) { im.classList.toggle('on', i === j); });
      cur = b.dataset.state || 'idle';
      if (mascot) mascot.setAttribute('data-state', cur);
      window.__nyraState();
    })(0);
  }

  /* ---------- flip cards ---------- */
  document.querySelectorAll('.flip').forEach(function (card) {
    var front = card.querySelector('.front'), back = card.querySelector('.back');
    function set(on, focus) {
      card.classList.toggle('on', on);
      front.setAttribute('aria-hidden', String(on)); back.setAttribute('aria-hidden', String(!on));
      front.inert = on; back.inert = !on;
      if (focus) (on ? back : front).querySelector('.turn').focus({ preventScroll: true });
    }
    card.querySelectorAll('.turn').forEach(function (b) {
      b.addEventListener('click', function () { set(!card.classList.contains('on'), true); });
    });
    set(false);
  });

  /* ---------- 团子 eyes follow the pointer (hero + final) ---------- */
  var eyes = Array.prototype.slice.call(document.querySelectorAll('.bot.follow .eyes'));
  if (eyes.length && !reduce && matchMedia('(pointer: fine)').matches) {
    var px = 0, py = 0, raf = 0;
    window.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY;
      if (!raf) raf = requestAnimationFrame(function () {
        raf = 0;
        eyes.forEach(function (g) {
          var r = g.ownerSVGElement.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight) return;
          var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          var dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 400);
          g.style.transform = 'translate(' + (dx / d * 7 * k).toFixed(2) + 'px,' + (dy / d * 6 * k).toFixed(2) + 'px)';
        });
      });
    }, { passive: true });
  }
})();
