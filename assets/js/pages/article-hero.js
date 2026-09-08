// Sync page hero spacer -- shared across every article/case-study post page
// (mirrors the per-page hero-spacer scripts under assets/js/pages/*.js,
// generalized here since every post shares the same auto-generated hero).
  function syncPageHeroSpacer() {
    var h = document.querySelector('.page-hero, .hero-section');
    var s = document.getElementById('page-hero-spacer');
    if (h && s) s.style.height = (h.offsetHeight - parseInt(getComputedStyle(document.body).paddingTop)) + 'px';
  }
  syncPageHeroSpacer();
  window.addEventListener('resize', syncPageHeroSpacer);

  const pg = (location.pathname.split('/').pop() || '').replace('.html', '');
  const navKey = pg.indexOf('case-study-') === 0 ? 'case-studies' : pg.indexOf('article-') === 0 ? 'articles' : '';
  if (navKey) {
    document.querySelectorAll('.nav-links-pill a[data-page]').forEach(a => { if (a.dataset.page === navKey) a.classList.add('active'); });
  }

  const ro = new IntersectionObserver(entries => { entries.forEach(e => { if(e.isIntersecting){e.target.classList.add('visible');}else{e.target.classList.remove('visible');} }); }, {threshold:0.12});
  document.querySelectorAll('.reveal,.reveal-left,.reveal-right,.reveal-scale,.stagger').forEach(el => ro.observe(el));
