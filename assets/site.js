/* ══════════════════════════════════════════════════════════
   Shared site behaviour — theme, navigation, reveal, terms.
   ══════════════════════════════════════════════════════════ */

// ── THEME TOGGLE ───────────────────────────────────────
(function () {
  function currentTheme() {
    var explicit = document.documentElement.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  }
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', toggleTheme);
  });
})();

// ── NAV: shadow on scroll ──────────────────────────────
(function () {
  var nav = document.getElementById('nav');
  if (!nav) return;
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 20); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// ── NAV: mobile panel ──────────────────────────────────
(function () {
  var btn   = document.getElementById('menu-toggle');
  var panel = document.getElementById('nav-panel');
  if (!btn || !panel) return;
  var open  = document.getElementById('menu-icon-open');
  var close = document.getElementById('menu-icon-close');

  function setOpen(isOpen) {
    panel.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));
    if (open)  open.style.display  = isOpen ? 'none'  : 'block';
    if (close) close.style.display = isOpen ? 'block' : 'none';
  }
  btn.addEventListener('click', function () {
    setOpen(!panel.classList.contains('open'));
  });
  panel.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () { setOpen(false); });
  });
})();

// ── NAV: active page + sliding indicator ───────────────
(function () {
  var links     = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
  var panelLnks = Array.prototype.slice.call(document.querySelectorAll('#nav-panel a'));
  var indicator = document.getElementById('nav-indicator');
  var container = document.getElementById('nav-links');
  if (!links.length) return;

  // Page slug, with or without the .html extension; "/" means the homepage.
  function slug(path) {
    return path.split('/').pop().replace(/\.html$/, '') || 'index';
  }
  var file = slug(window.location.pathname);
  var hovered = null;

  function isActive(a) {
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return false;
    return slug(href) === file;
  }

  function moveIndicator(link) {
    if (!link || !indicator || !container) {
      if (indicator) indicator.style.opacity = '0';
      return;
    }
    indicator.style.opacity = '1';
    indicator.style.left   = link.offsetLeft + 'px';
    indicator.style.width  = link.offsetWidth + 'px';
    indicator.style.top    = link.offsetTop + 'px';
    indicator.style.height = link.offsetHeight + 'px';
  }

  var activeLink = links.filter(isActive)[0] || null;

  function render() {
    links.forEach(function (l) { l.classList.toggle('active', l === activeLink); });
    panelLnks.forEach(function (l) { l.classList.toggle('active', isActive(l)); });
    moveIndicator(hovered || activeLink);
  }

  links.forEach(function (l) {
    l.addEventListener('mouseenter', function () { hovered = l; render(); });
  });
  if (container) {
    container.addEventListener('mouseleave', function () { hovered = null; render(); });
  }

  window.addEventListener('resize', render);
  window.addEventListener('load', render);
  render();
})();

// ── REVEAL ON SCROLL ───────────────────────────────────
(function () {
  var els = document.querySelectorAll('.reveal');
  if (!els.length) return;
  if (!('IntersectionObserver' in window)) {
    els.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
  els.forEach(function (el) { io.observe(el); });
})();

// ── EMAIL: assemble only on interaction to reduce basic scraping ──
(function () {
  var links = document.querySelectorAll('[data-email-link]');
  if (!links.length) return;

  function address() {
    return ['xiao', 'zhang'].join('_') + String.fromCharCode(64) + ['berkeley', 'edu'].join('.');
  }

  links.forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      window.location.href = 'mailto:' + address();
    });
  });
})();

// ── SEMESTER TRACKER (Education page) ──────────────────
(function () {
  var track = document.getElementById('term-track');
  if (!track) return;

  var TERMS = [
    { name: "Fall 2025",   start: new Date("2025-06-01"), end: new Date("2025-12-31") },
    { name: "Spring 2026", start: new Date("2026-01-01"), end: new Date("2026-05-31") },
    { name: "Fall 2026",   start: new Date("2026-06-01"), end: new Date("2026-12-31") },
    { name: "Spring 2027", start: new Date("2027-01-01"), end: new Date("2027-05-31") },
    { name: "Fall 2027",   start: new Date("2027-06-01"), end: new Date("2027-12-31") },
    { name: "Spring 2028", start: new Date("2028-01-01"), end: new Date("2028-05-31") }
  ];

  function getTrackerDate() {
    var debugDate = new URLSearchParams(window.location.search).get('termDate');
    return debugDate ? new Date(debugDate + "T12:00:00") : new Date();
  }

  function getActiveTerm(now) {
    return TERMS.filter(function (t) { return now >= t.start && now <= t.end; })[0];
  }

  function centerCurrentTerm() {
    var current = track.querySelector('.term-icon.current');
    if (!current) return;
    track.classList.add('is-scrollable');
    var scrollable = track.scrollWidth > track.clientWidth + 1;
    track.classList.toggle('is-scrollable', scrollable);
    if (!scrollable) { track.scrollLeft = 0; return; }
    var node = current.closest('.term-node');
    var target = node.offsetLeft + node.offsetWidth / 2 - track.clientWidth / 2;
    track.scrollLeft = Math.max(0, Math.min(target, track.scrollWidth - track.clientWidth));
  }

  function renderTermTrack() {
    var now = getTrackerDate();
    var html = '';

    TERMS.forEach(function (t, i) {
      var dotClass, labelStyle;
      if (now > t.end) {
        dotClass   = 'done';
        labelStyle = 'color:var(--neutral-400);text-decoration:line-through';
      } else if (now >= t.start && now <= t.end) {
        dotClass   = 'current';
        labelStyle = 'color:var(--accent);font-weight:700';
      } else {
        dotClass   = 'future';
        labelStyle = 'color:var(--neutral-500)';
      }

      if (i > 0) {
        html += '<div class="term-connector ' + (now > TERMS[i - 1].end ? 'done' : '') + '"></div>';
      }

      html += '<div class="term-node">' +
                '<div class="term-icon-wrap"><div class="term-icon ' + dotClass + '"></div></div>' +
                '<div class="term-label" style="' + labelStyle + '">' + t.name.replace(' ', ' ') + '</div>' +
              '</div>';
    });

    track.innerHTML = html;
    centerCurrentTerm();
  }

  function updateInProgressBadge() {
    var activeTerm = getActiveTerm(getTrackerDate());
    var ipBlock = document.querySelector('.cw-block.in-progress');
    var badge = document.getElementById('ip-badge');
    if (!badge || !activeTerm || !ipBlock) return;
    var count = ipBlock.querySelectorAll('.course-status.active').length;
    badge.textContent = activeTerm.name + ' · ' + count + ' course' + (count !== 1 ? 's' : '');
  }

  renderTermTrack();
  updateInProgressBadge();
  window.addEventListener('resize', centerCurrentTerm);
})();
