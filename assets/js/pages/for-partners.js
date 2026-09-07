// Sync page hero spacer
  function syncPageHeroSpacer() {
    var h = document.querySelector('.page-hero, .hero-section');
    var s = document.getElementById('page-hero-spacer');
    if (h && s) s.style.height = (h.offsetHeight - parseInt(getComputedStyle(document.body).paddingTop)) + 'px';
  }
  syncPageHeroSpacer();
  window.addEventListener('resize', syncPageHeroSpacer);

  Chart.defaults.color = '#888888';
  Chart.defaults.font.family = "'Montserrat', sans-serif";
  Chart.defaults.font.size = 11;
  const LINE = 'rgba(255,255,255,0.08)';
  const ORANGE = '#e95c25';

  new Chart(document.getElementById('salesCycleChart'), {
    type: 'bar',
    data: { labels: ['Before Blacfox', 'After Blacfox'], datasets: [{ data: [8, 4], backgroundColor: ['rgba(255,255,255,0.12)', ORANGE], borderWidth: 0, borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.raw} months` } } }, scales: { x: { grid: { color: LINE }, ticks: { color: '#888' } }, y: { grid: { color: LINE }, ticks: { color: '#888', callback: v => v + ' mo' }, max: 10 } } }
  });

  new Chart(document.getElementById('adeptOutcomesChart'), {
    type: 'bar',
    data: { labels: ['Pipeline growth (×)', 'Partners reactivated', 'ROI on co-op (×)'], datasets: [{ data: [2, 47, 10], backgroundColor: [ORANGE, 'rgba(233,92,37,0.4)', ORANGE], borderWidth: 0, borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataIndex === 1 ? ` ${ctx.raw} dormant partners reactivated` : ` ${ctx.raw}×` } } }, scales: { x: { grid: { color: LINE }, ticks: { color: '#888' } }, y: { grid: { color: LINE }, ticks: { color: '#888' } } } }
  });
  const pg = (location.pathname.split('/').pop()||'index.html').replace('.html','') || 'index';
  document.querySelectorAll('.nav-links-pill a[data-page]').forEach(a => { if(a.dataset.page===pg) a.classList.add('active'); });
  const ro = new IntersectionObserver(entries => { entries.forEach(e => { if(e.isIntersecting){e.target.classList.add('visible');}else{e.target.classList.remove('visible');} }); }, {threshold:0.12});
  document.querySelectorAll('.reveal,.reveal-left,.reveal-right,.reveal-scale,.stagger').forEach(el => ro.observe(el));
  // FAQ accordion is wired site-wide in assets/js/nav.js
