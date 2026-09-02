// Sync page hero spacer
  function syncPageHeroSpacer() {
    var h = document.querySelector('.page-hero, .hero-section');
    var s = document.getElementById('page-hero-spacer');
    if (h && s) s.style.height = (h.offsetHeight - parseInt(getComputedStyle(document.body).paddingTop)) + 'px';
  }
  syncPageHeroSpacer();
  window.addEventListener('resize', syncPageHeroSpacer);

  const pg = (location.pathname.split('/').pop()||'index.html').replace('.html','') || 'index';
  document.querySelectorAll('.nav-links-pill a[data-page]').forEach(a => { if(a.dataset.page===pg) a.classList.add('active'); });
  const ro = new IntersectionObserver(entries => { entries.forEach(e => { if(e.isIntersecting){e.target.classList.add('visible');}else{e.target.classList.remove('visible');} }); }, {threshold:0.12});
  document.querySelectorAll('.reveal,.reveal-left,.reveal-right,.reveal-scale,.stagger').forEach(el => ro.observe(el));
  document.querySelectorAll('.faq-item').forEach(item => {
    item.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  // Replay method arc charts on scroll
  (function() {
    var mc = document.querySelector('.method-charts');
    if (!mc) return;
    var arcs = mc.querySelectorAll('.m-arc-full,.m-arc-40,.m-arc-20,.m-arc-dot');
    function replayArcs() {
      arcs.forEach(function(el) { el.style.animation = 'none'; });
      void document.body.offsetWidth;
      arcs.forEach(function(el) { el.style.animation = ''; });
    }
    new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting) replayArcs();
    }, { threshold: 0.3 }).observe(mc);
  })();
