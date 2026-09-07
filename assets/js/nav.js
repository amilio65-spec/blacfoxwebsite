// Mobile hamburger toggle for the nav-links pill (partials/nav.html).
// Loaded on every page, no-ops on desktop widths since #nav-toggle is
// display:none there.
(function () {
  const toggle = document.getElementById('nav-toggle');
  const list = document.getElementById('nav-links-list');
  if (!toggle || !list) return;

  function closeMenu() {
    toggle.classList.remove('open');
    list.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    toggle.classList.add('open');
    list.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', () => {
    if (list.classList.contains('open')) closeMenu();
    else openMenu();
  });

  list.addEventListener('click', e => {
    if (e.target.closest('a')) closeMenu();
  });

  document.addEventListener('click', e => {
    if (!list.classList.contains('open')) return;
    if (list.contains(e.target) || toggle.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 640) closeMenu();
  });
})();

// FAQ accordion -- centralized here (rather than duplicated per-page) so any
// page's .faq-item sections work regardless of that page's own pageScripts,
// e.g. the CMS's "Heading + Text + FAQ" component inserted on a page that
// doesn't otherwise carry this wiring.
document.querySelectorAll('.faq-item').forEach(item => {
  item.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});
