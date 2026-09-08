// Assembles the finished HTML pages from partials/ + pages/*.md into dist/.
// Plain Node, no dependencies -- run with `npm run build` (node build.js).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PAGES_DIR = path.join(ROOT, 'pages');
const PARTIALS_DIR = path.join(ROOT, 'partials');
const DIST_DIR = path.join(ROOT, 'dist');
const ARTICLES_DIR = path.join(ROOT, 'content', 'articles');
const CASE_STUDIES_DIR = path.join(ROOT, 'content', 'case-studies');

// Articles and case studies are both "posts": a markdown collection under
// content/<dir>/, each built to dist/<prefix><slug>.html, with a matching
// grid marker spliced into that collection's index page. Kept as two
// separate on-disk collections (rather than one with a type field) so a
// non-technical editor sees them as distinct sidebar sections in the CMS,
// matching how they're presented on the site (separate nav items).
const POST_KINDS = {
  article: { dir: ARTICLES_DIR, prefix: 'article-', label: 'Article', pluralLabel: 'articles', gridMarker: '<!--ARTICLES-GRID-->' },
  'case-study': { dir: CASE_STUDIES_DIR, prefix: 'case-study-', label: 'Case Study', pluralLabel: 'case studies', gridMarker: '<!--CASESTUDIES-GRID-->' },
};

const LAYOUTS = {
  home: {
    spacerId: 'hero-spacer',
    wrapOpen: '<div id="page-content">',
    wrapClose: '</div><!-- /page-content -->',
  },
  inner: {
    spacerId: 'page-hero-spacer',
    wrapOpen: '<div class="other-page-content">',
    wrapClose: '</div><!-- /other-page-content -->',
  },
};

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('missing frontmatter');
  const [, fmText, body] = match;
  const data = {};
  for (const line of fmText.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    try {
      data[key] = JSON.parse(value);
    } catch {
      data[key] = value; // plain scalar, e.g. `layout: home`
    }
  }
  return { data, body };
}

function renderHead(headTemplate, data) {
  const cssLinks = data.cssFiles
    .map(href => `<link rel="stylesheet" href="${href}">`)
    .join('\n');
  const ogImage = data.ogImage || 'assets/og/default.png';
  return headTemplate
    .replaceAll('{{title}}', data.title)
    .replaceAll('{{description}}', data.description)
    .replaceAll('{{canonical}}', data.canonical)
    .replaceAll('{{ogImage}}', ogImage)
    .replace('{{cssLinks}}', cssLinks);
}

function renderPage({ data, body }, partials) {
  const layout = LAYOUTS[data.layout];
  if (!layout) throw new Error(`unknown layout: ${data.layout}`);

  const [heroPart, mainPart] = body.split('<!--CONTENT-WRAP-->');

  const pageScripts = data.pageScripts
    .map(src => `<script src="${src}"></script>`)
    .join('\n');

  const bodyClassAttr = data.bodyClass ? ` class="${data.bodyClass}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead(partials.head, data)}
</head>
<body${bodyClassAttr}>
<div aria-hidden="true" style="position:fixed;top:0;left:0;width:100%;height:8px;z-index:1001;pointer-events:none;background-image:url('assets/icons/accent-strip.svg');background-size:100% 100%;background-repeat:no-repeat;"></div>

${partials.nav}
${heroPart.trim()}
<div id="${layout.spacerId}"></div>
${layout.wrapOpen}

${mainPart.trim()}

${partials.footer}

${pageScripts}
${layout.wrapClose}
<script src="assets/js/hero-bg-grid.js"></script>
<script src="assets/js/nav.js"></script>
<script src="segment-gate.js" defer></script>
</body>
</html>
`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatArticleDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Posts (articles + case studies) get an auto-generated hero
// (kind/title/author/date/banner) rather than hand-authored hero HTML --
// non-technical staff fill in the fields, the CMS never lets them touch
// this markup directly.
function renderPostHero(data, kindLabel) {
  const metaLine = [data.author, formatArticleDate(data.date)].filter(Boolean).join(' — ');
  const panelInner = data.banner
    ? `<img src="${data.banner}" alt="${escHtml(data.title || '')}">`
    : `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.75"/><path d="M21 15l-5-5L5 21"/></svg><span>Illustration placeholder</span>`;
  return `<section class="hero-section article-hero" style="position:relative;overflow:hidden;min-height:100vh;">
  <canvas class="hero-bg-grid"></canvas>
  <div class="hero-split" style="position:relative;z-index:1;width:100%;max-width:1240px;margin:0 auto;">
    <div>
      <p class="section-tag reveal">${escHtml(kindLabel)}</p>
      <h1 class="hero-title">${escHtml(data.title || 'Untitled')}</h1>
      ${metaLine ? `<p class="hero-meta reveal">${escHtml(metaLine)}</p>` : ''}
    </div>
    <div class="hero-quote-panel ${data.banner ? 'has-image' : 'is-placeholder'}">
      ${panelInner}
    </div>
  </div>
</section>`;
}

function renderPostPage(data, body, partials, kindLabel) {
  const layout = LAYOUTS.inner;
  const bodyClassAttr = data.bodyClass ? ` class="${data.bodyClass}"` : '';
  const pageScripts = (data.pageScripts || [])
    .map(src => `<script src="${src}"></script>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead(partials.head, data)}
</head>
<body${bodyClassAttr}>
<div aria-hidden="true" style="position:fixed;top:0;left:0;width:100%;height:8px;z-index:1001;pointer-events:none;background-image:url('assets/icons/accent-strip.svg');background-size:100% 100%;background-repeat:no-repeat;"></div>

${partials.nav}
${renderPostHero(data, kindLabel)}
<div id="${layout.spacerId}"></div>
${layout.wrapOpen}

<div class="article-body">
${body.trim()}
</div>

${partials.footer}

${pageScripts}
${layout.wrapClose}
<script src="assets/js/hero-bg-grid.js"></script>
<script src="assets/js/pages/article-hero.js"></script>
<script src="assets/js/nav.js"></script>
<script src="segment-gate.js" defer></script>
</body>
</html>
`;
}

// Spliced into pages/articles.md and pages/case-studies.md wherever they
// contain their respective grid marker (see build(), below).
function renderPostsGrid(posts, prefix, emptyLabel) {
  const sorted = posts.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!sorted.length) {
    return `<p class="section-p" style="text-align:center">No ${emptyLabel} published yet — check back soon.</p>`;
  }
  return `<div class="card-grid-3 stagger article-grid">
${sorted.map(a => `  <a class="dark-card article-card" href="${prefix}${a.slug}.html">
    <div class="article-card-thumb">${a.banner ? `<img src="${a.banner}" alt="${escHtml(a.title || '')}" loading="lazy">` : ''}</div>
    <p class="card-num">${escHtml(formatArticleDate(a.date))}</p>
    <p class="card-title">${escHtml(a.title || 'Untitled')}</p>
    <p class="card-body">${escHtml(a.description || '')}</p>
  </a>`).join('\n')}
</div>`;
}

// Spliced into pages/index.md wherever it contains the
// <!--FEATURED-CAROUSEL--> marker -- a horizontally-scrolling strip pulling
// the newest items from BOTH post collections together, newest first.
function renderFeaturedCarousel(articles, caseStudies) {
  const items = [
    ...articles.map(a => ({ ...a, prefix: 'article-', kindLabel: 'Article' })),
    ...caseStudies.map(c => ({ ...c, prefix: 'case-study-', kindLabel: 'Case Study' })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10);
  if (!items.length) return '';
  return `<section class="bg-white featured-carousel-section">
  <div class="section-inner">
    <p class="section-tag reveal">From the team</p>
    <h2 class="section-h reveal">Articles &amp; <em>case studies.</em></h2>
  </div>
  <div class="featured-carousel-wrap">
    <button type="button" class="carousel-arrow carousel-prev" aria-label="Scroll left">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="featured-carousel-track" id="featured-carousel-track">
${items.map(item => `      <a class="dark-card article-card featured-carousel-card" href="${item.prefix}${item.slug}.html">
        <div class="article-card-thumb">${item.banner ? `<img src="${item.banner}" alt="${escHtml(item.title || '')}" loading="lazy">` : ''}</div>
        <p class="card-num">${escHtml(item.kindLabel)} · ${escHtml(formatArticleDate(item.date))}</p>
        <p class="card-title">${escHtml(item.title || 'Untitled')}</p>
        <p class="card-body">${escHtml(item.description || '')}</p>
      </a>`).join('\n')}
    </div>
    <button type="button" class="carousel-arrow carousel-next" aria-label="Scroll right">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
</section>`;
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function build() {
  const partials = {
    head: fs.readFileSync(path.join(PARTIALS_DIR, 'head.html'), 'utf8'),
    nav: fs.readFileSync(path.join(PARTIALS_DIR, 'nav.html'), 'utf8').trim(),
    footer: fs.readFileSync(path.join(PARTIALS_DIR, 'footer.html'), 'utf8').trim(),
  };

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Articles and case studies are both separate collections under
  // content/<dir>/, each built to its own flat dist/<prefix><slug>.html
  // (deliberately NOT a nested articles/<slug>.html -- every other page
  // here uses root-relative asset paths with no leading slash, and a
  // nested URL would break every one of them without a whole extra layer
  // of path-prefixing logic). Optional: skipped if its content/ dir
  // doesn't exist yet.
  const postsByKind = {};
  let totalPosts = 0;
  for (const [kind, cfg] of Object.entries(POST_KINDS)) {
    const posts = [];
    if (fs.existsSync(cfg.dir)) {
      const files = fs.readdirSync(cfg.dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const raw = fs.readFileSync(path.join(cfg.dir, file), 'utf8');
        const { data, body } = parseFrontmatter(raw);
        const slug = file.replace(/\.md$/, '');
        posts.push({ slug, ...data });
        const html = renderPostPage(data, body, partials, cfg.label);
        const outName = `${cfg.prefix}${slug}.html`;
        fs.writeFileSync(path.join(DIST_DIR, outName), html, 'utf8');
        console.log('built', outName);
      }
    } else {
      console.log(`skipped ${path.relative(ROOT, cfg.dir)}/ (not present yet)`);
    }
    postsByKind[kind] = posts;
    totalPosts += posts.length;
  }

  const pageFiles = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.md'));
  for (const file of pageFiles) {
    const raw = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
    const parsed = parseFrontmatter(raw);
    for (const [kind, cfg] of Object.entries(POST_KINDS)) {
      if (parsed.body.includes(cfg.gridMarker)) {
        parsed.body = parsed.body.replace(cfg.gridMarker, renderPostsGrid(postsByKind[kind], cfg.prefix, cfg.pluralLabel));
      }
    }
    if (parsed.body.includes('<!--FEATURED-CAROUSEL-->')) {
      parsed.body = parsed.body.replace('<!--FEATURED-CAROUSEL-->', renderFeaturedCarousel(postsByKind.article, postsByKind['case-study']));
    }
    const html = renderPage(parsed, partials);
    const outName = file.replace(/\.md$/, '.html');
    fs.writeFileSync(path.join(DIST_DIR, outName), html, 'utf8');
    console.log('built', outName);
  }

  copyRecursive(path.join(ROOT, 'assets'), path.join(DIST_DIR, 'assets'));

  // Blacfox CMS admin app (static, GitHub-API-backed) -- copied verbatim so
  // it deploys at /admin/ alongside the public site. Optional: skipped if
  // the admin/ folder doesn't exist yet (e.g. before the CMS is added to a repo).
  const adminSrc = path.join(ROOT, 'admin');
  if (fs.existsSync(adminSrc)) {
    copyRecursive(adminSrc, path.join(DIST_DIR, 'admin'));
  } else {
    console.log('skipped admin/ (not present)');
  }
  // segment-gate.css/js are an intentional future placeholder and don't exist
  // in this repo yet (see README "Known gaps") -- copy them if/when they land.
  for (const placeholder of ['segment-gate.css', 'segment-gate.js']) {
    const src = path.join(ROOT, placeholder);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(DIST_DIR, placeholder));
    } else {
      console.log(`skipped ${placeholder} (not present yet)`);
    }
  }

  console.log(`Done. ${pageFiles.length} pages and ${totalPosts} posts (articles + case studies) built to /dist.`);
}

build();
