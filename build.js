// Assembles the finished HTML pages from partials/ + pages/*.md into dist/.
// Plain Node, no dependencies -- run with `npm run build` (node build.js).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PAGES_DIR = path.join(ROOT, 'pages');
const PARTIALS_DIR = path.join(ROOT, 'partials');
const DIST_DIR = path.join(ROOT, 'dist');

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
<script src="segment-gate.js" defer></script>
</body>
</html>
`;
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

  const pageFiles = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.md'));
  for (const file of pageFiles) {
    const raw = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
    const parsed = parseFrontmatter(raw);
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

  console.log(`Done. ${pageFiles.length} pages built to /dist.`);
}

build();
