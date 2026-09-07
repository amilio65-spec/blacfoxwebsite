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
  // FAQ accordion is wired site-wide in assets/js/nav.js
