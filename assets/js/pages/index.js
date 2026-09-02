// Sync hero spacer height to the auto-height hero so page-content slides over correctly
  function syncHeroSpacer() {
    const h = document.getElementById('hero');
    const s = document.getElementById('hero-spacer');
    if (h && s) s.style.height = (h.offsetHeight - parseInt(getComputedStyle(document.body).paddingTop)) + 'px';
  }
  syncHeroSpacer();
  window.addEventListener('resize', syncHeroSpacer);

  // Replay chart animations every time chart-pair scrolls into view
  (function() {
    var chartPair = document.querySelector('.chart-pair');
    if (!chartPair) return;
    var animated = chartPair.querySelectorAll('.bar-blacfox,.bar-dot-blacfox,.bar-bench,.bar-dot-bench,.arc-fill,#arcDotEnd');
    function replay() {
      // 1. Strip animation from every element
      animated.forEach(function(el) { el.style.animation = 'none'; });
      // 2. Single reflow that flushes ALL elements — works for SVG too
      void document.body.offsetWidth;
      // 3. Restore CSS-defined animations so they play from the start
      animated.forEach(function(el) { el.style.animation = ''; });
    }
    new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting) replay();
    }, { threshold: 0.4 }).observe(chartPair);
  })();

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

  // PMF Wave Animation
  const waveEl = document.getElementById('wavePathDraw');
  const dotEl  = document.getElementById('pmfDot');
  const dotAnimEl = document.getElementById('pmfDotAnim');
  if (waveEl) {
    const pathLen = waveEl.getTotalLength();
    function startWave() {
      waveEl.style.transition = 'none';
      waveEl.style.strokeDasharray = pathLen;
      waveEl.style.strokeDashoffset = pathLen;
      dotEl.setAttribute('opacity', '1');
      void waveEl.getBoundingClientRect();
      waveEl.style.transition = 'stroke-dashoffset 3s cubic-bezier(0.4,0,0.2,1)';
      waveEl.style.strokeDashoffset = '0';
      dotAnimEl.beginElement();
    }
    function resetWave() {
      waveEl.style.transition = 'none';
      waveEl.style.strokeDasharray = pathLen;
      waveEl.style.strokeDashoffset = pathLen;
      dotEl.setAttribute('opacity', '0');
    }
    resetWave();
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) startWave(); else resetWave();
    }, { threshold: 0.25 }).observe(document.getElementById('pmfWaveSection'));
  }
