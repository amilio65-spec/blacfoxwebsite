// Assembles the finished HTML pages from partials/ + pages/*.md into dist/.
// Plain Node, no dependencies -- run with `npm run build` (node build.js).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PAGES_DIR = path.join(ROOT, 'pages');
const PARTIALS_DIR = path.join(ROOT, 'partials');
const DIST_DIR = path.join(ROOT, 'dist');
const ARTICLES_DIR = path.join(ROOT, 'content', 'articles');

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

// Articles get an auto-generated hero (title/author/date/banner) rather
// than hand-authored hero HTML -- non-technical staff fill in the fields,
// the CMS never lets them touch this markup directly.
function renderArticleHero(data) {
  const metaLine = [data.author, formatArticleDate(data.date)].filter(Boolean).join(' — ');
  return `<section class="hero-section article-hero">
  <canvas class="hero-bg-grid"></canvas>
  <div class="section-inner">
    <p class="section-tag reveal">Article</p>
    <h1 class="hero-title">${escHtml(data.title || 'Untitled')}</h1>
    ${metaLine ? `<p class="article-meta reveal">${escHtml(metaLine)}</p>` : ''}
  </div>
</section>
${data.banner ? `<div class="article-banner-wrap"><img class="article-banner" src="${data.banner}" alt="${escHtml(data.title || '')}"></div>` : ''}`;
}

function renderArticlePage(data, body, partials) {
  const layout = LAYOUTS.inner;
  const bodyClassAttr = data.bodyClass ? ` class="${data.bodyClass}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead(partials.head, data)}
</head>
<body${bodyClassAttr}>
<div aria-hidden="true" style="position:fixed;top:0;left:0;width:100%;height:8px;z-index:1001;pointer-events:none;background-image:url('assets/icons/accent-strip.svg');background-size:100% 100%;background-repeat:no-repeat;"></div>

${partials.nav}
${renderArticleHero(data)}
<div id="${layout.spacerId}"></div>
${layout.wrapOpen}

<div class="article-body">
${body.trim()}
</div>

${partials.footer}

${layout.wrapClose}
<script src="assets/js/hero-bg-grid.js"></script>
<script src="assets/js/nav.js"></script>
<script src="segment-gate.js" defer></script>
</body>
</html>
`;
}

// Spliced into pages/articles.md wherever it contains the
// <!--ARTICLES-GRID--> marker (see build(), below).
function renderArticlesGrid(articles) {
  const sorted = articles.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!sorted.length) {
    return `<p class="section-p" style="text-align:center">No articles published yet — check back soon.</p>`;
  }
  return `<div class="card-grid-3 stagger article-grid">
${sorted.map(a => `  <a class="dark-card article-card" href="article-${a.slug}.html">
    <div class="article-card-thumb">${a.banner ? `<img src="${a.banner}" alt="${escHtml(a.title || '')}" loading="lazy">` : ''}</div>
    <p class="card-num">${escHtml(formatArticleDate(a.date))}</p>
    <p class="card-title">${escHtml(a.title || 'Untitled')}</p>
    <p class="card-body">${escHtml(a.description || '')}</p>
  </a>`).join('\n')}
</div>`;
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

  // Articles are a separate collection under content/articles/, each one
  // built to its own flat dist/article-<slug>.html (deliberately NOT a
  // nested articles/<slug>.html -- every other page here uses root-relative
  // asset paths with no leading slash, and a nested URL would break every
  // one of them without a whole extra layer of path-prefixing logic).
  // Optional: skipped entirely if content/articles/ doesn't exist yet.
  let articles = [];
  if (fs.existsSync(ARTICLES_DIR)) {
    const articleFiles = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md'));
    for (const file of articleFiles) {
      const raw = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
      const { data, body } = parseFrontmatter(raw);
      const slug = file.replace(/\.md$/, '');
      articles.push({ slug, ...data });
      const html = renderArticlePage(data, body, partials);
      const outName = `article-${slug}.html`;
      fs.writeFileSync(path.join(DIST_DIR, outName), html, 'utf8');
      console.log('built', outName);
    }
  } else {
    console.log('skipped content/articles/ (not present yet)');
  }

  const pageFiles = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.md'));
  for (const file of pageFiles) {
    const raw = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
    const parsed = parseFrontmatter(raw);
    if (parsed.body.includes('<!--ARTICLES-GRID-->')) {
      parsed.body = parsed.body.replace('<!--ARTICLES-GRID-->', renderArticlesGrid(articles));
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

  console.log(`Done. ${pageFiles.length} pages and ${articles.length} articles built to /dist.`);
}

build();
