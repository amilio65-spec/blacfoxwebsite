/* ============================================================
   Blacfox CMS — client-only, GitHub-backed content editor.

   No backend. No database. Every save is a real git commit made
   directly from this browser via the GitHub REST API, using a
   personal access token the user pastes in once (kept only in
   localStorage). Draft = a branch; Publish = merge that branch
   into `main`, which Cloudflare's existing deploy hook picks up.

   Nothing here is hardcoded to any one repo — owner/repo/token
   live in localStorage and are set from the login screen, so the
   exact same file works against the test repo and, later, the
   real one.
   ============================================================ */

const GH_API = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';

/* ------------------------------------------------------------
   Settings (localStorage)
   ------------------------------------------------------------ */
const Settings = {
  KEY: 'bxcms_settings_v1',
  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); }
    catch { return null; }
  },
  save(s) { localStorage.setItem(this.KEY, JSON.stringify(s)); },
  clear() { localStorage.removeItem(this.KEY); },
};

/* ------------------------------------------------------------
   Base64 helpers (unicode-safe, and a raw-bytes variant for
   binary uploads like OG images)
   ------------------------------------------------------------ */
function b64EncodeText(str) {
  const bytes = new TextEncoder().encode(str);
  return bytesToB64(bytes);
}
function b64DecodeText(b64) {
  const bytes = b64ToBytes(b64);
  return new TextDecoder('utf-8').decode(bytes);
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------
   GitHub API wrapper
   ------------------------------------------------------------ */
const gh = {
  token: '', owner: '', repo: '',

  headers(extra) {
    return Object.assign({
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, extra || {});
  },

  async req(path, opts = {}) {
    const res = await fetch(`${GH_API}${path}`, {
      ...opts,
      headers: this.headers(opts.headers),
    });
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const msg = (body && body.message) ? body.message : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  },

  async whoami() { return this.req('/user'); },

  async getRepo(owner, repo) { return this.req(`/repos/${owner}/${repo}`); },

  async listBranches(owner, repo) {
    return this.req(`/repos/${owner}/${repo}/branches?per_page=100`);
  },

  async getRef(owner, repo, branch) {
    return this.req(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent('heads/' + branch)}`);
  },

  async createBranch(owner, repo, newBranch, fromBranch) {
    const ref = await this.getRef(owner, repo, fromBranch);
    return this.req(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: ref.object.sha }),
    });
  },

  // Returns {text, sha} or null if the file doesn't exist on that ref.
  async getFile(owner, repo, path, ref) {
    try {
      const data = await this.req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`);
      if (Array.isArray(data)) return { dir: data };
      return { text: b64DecodeText(data.content), sha: data.sha, raw: data };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  async putFile(owner, repo, path, contentB64, message, branch, sha) {
    const body = { message, content: contentB64, branch };
    if (sha) body.sha = sha;
    return this.req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  async deleteFile(owner, repo, path, message, branch, sha) {
    return this.req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, sha, branch }),
    });
  },

  async merge(owner, repo, base, head, commit_message) {
    return this.req(`/repos/${owner}/${repo}/merges`, {
      method: 'POST',
      body: JSON.stringify({ base, head, commit_message }),
    });
  },

  // Returns raw base64 (undecoded) of a file's bytes, or null if missing.
  // Falls back to the Git Blob API for files >1MB, which the Contents API
  // can't inline (this matters for this repo's fonts.css, ~1.7MB) --
  // and, critically, both endpoints are authenticated, so this works
  // against a PRIVATE repo, unlike an unauthenticated raw.githubusercontent.com
  // fetch (which 404s on a private repo with no way to tell the difference
  // from a missing file).
  async getFileBytesB64(owner, repo, path, ref) {
    try {
      const data = await this.req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`);
      if (Array.isArray(data)) return null;
      if (data.content) return data.content.replace(/\n/g, '');
      if (data.sha) {
        const blob = await this.req(`/repos/${owner}/${repo}/git/blobs/${data.sha}`);
        return blob.content.replace(/\n/g, '');
      }
      return null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
};

function guessMime(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return {
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  }[ext] || 'application/octet-stream';
}

/* ------------------------------------------------------------
   Build-pipeline mirror (must match build.js exactly, so the
   live preview shows what `npm run build` will actually produce)
   ------------------------------------------------------------ */
const LAYOUTS = {
  home:  { spacerId: 'hero-spacer',      wrapOpen: '<div id="page-content">',           wrapClose: '</div><!-- /page-content -->' },
  inner: { spacerId: 'page-hero-spacer', wrapOpen: '<div class="other-page-content">',  wrapClose: '</div><!-- /other-page-content -->' },
};

const META_FIELD_ORDER = ['title', 'description', 'cssFiles', 'bodyClass', 'layout', 'canonical', 'pageScripts', 'ogImage'];

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
    try { data[key] = JSON.parse(value); } catch { data[key] = value; }
  }
  return { data, body };
}

function serializeFrontmatter(data, body) {
  const lines = [];
  for (const key of META_FIELD_ORDER) {
    const v = data[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'layout') { lines.push(`layout: ${v}`); continue; }
    lines.push(`${key}: ${JSON.stringify(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n\n${body.replace(/^\n+/, '')}`;
}

function splitBody(body) {
  const marker = '<!--CONTENT-WRAP-->';
  const idx = body.indexOf(marker);
  if (idx === -1) return { hero: body.trim(), main: '' };
  return { hero: body.slice(0, idx).trim(), main: body.slice(idx + marker.length).trim() };
}
function joinBody(hero, main) {
  return `${hero.trim()}\n\n<!--CONTENT-WRAP-->\n\n${main.trim()}\n`;
}

function renderHeadClient(headTemplate, data) {
  const cssLinks = (data.cssFiles || []).map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
  const ogImage = data.ogImage || 'assets/og/default.png';
  return headTemplate
    .replaceAll('{{title}}', data.title || '')
    .replaceAll('{{description}}', data.description || '')
    .replaceAll('{{canonical}}', data.canonical || '')
    .replaceAll('{{ogImage}}', ogImage)
    .replace('{{cssLinks}}', cssLinks);
}

function renderPageClient(data, heroHTML, mainHTML, partials) {
  const layout = LAYOUTS[data.layout] || LAYOUTS.inner;
  const pageScripts = (data.pageScripts || []).map(src => `<script src="${src}"></script>`).join('\n');
  const bodyClassAttr = data.bodyClass ? ` class="${data.bodyClass}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
${renderHeadClient(partials.head, data)}
</head>
<body${bodyClassAttr}>
<div aria-hidden="true" style="position:fixed;top:0;left:0;width:100%;height:8px;z-index:1001;pointer-events:none;background-image:url('assets/icons/accent-strip.svg');background-size:100% 100%;background-repeat:no-repeat;"></div>

${partials.nav}
${heroHTML}
<div id="${layout.spacerId}"></div>
${layout.wrapOpen}

${mainHTML}

${partials.footer}

${pageScripts}
${layout.wrapClose}
<script src="assets/js/hero-bg-grid.js"></script>
<script src="segment-gate.js" defer></script>
</body>
</html>`;
}

/* ------------------------------------------------------------
   Component vocabulary for "+ Insert section" — modeled on the
   Landing Page Builder's fixed-block/component pattern, but
   rendered with THIS site's own real CSS idioms (section-tag /
   section-h / section-p / stats-section / trust-bar / card-grid-N
   / dark-card / faq-list / cta-section — all confirmed by reading
   the live pages/*.md, not guessed). Existing page bodies stay
   exactly as hand-authored HTML; this only generates NEW markup
   to splice in.
   ------------------------------------------------------------ */
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const COMPONENTS = {
  'section-tag': {
    label: 'Section Tag', hint: 'The small orange label above a heading, e.g. “How We Help”.',
    fields: [{ key: 'text', label: 'Text', type: 'text', default: 'Section Tag' }],
    render: f => `<p class="section-tag reveal">${escHtml(f.text)}</p>`,
  },
  'heading': {
    label: 'Section Heading', hint: 'Use <em>…</em> to italicise/highlight part of it, matching the rest of the site.',
    fields: [{ key: 'html', label: 'Heading (HTML allowed for <em>)', type: 'text', default: 'Section headline goes here' }],
    render: f => `<h2 class="section-h reveal">${f.html}</h2>`,
  },
  'body': {
    label: 'Body Paragraph', hint: '',
    fields: [{ key: 'html', label: 'Text', type: 'textarea', default: 'Describe the point of this section in one or two sentences.' }],
    render: f => `<p class="section-p reveal">${f.html}</p>`,
  },
  'stats': {
    label: 'Stats Row', hint: '3–4 big numbers with a caption under each.',
    fields: [{ key: 'items', label: 'Stats (value | label, one per line)', type: 'textarea', default: '10:1 | pipeline ACV return\n15+ | years experience\nB2B. | Tech only' }],
    render: f => {
      const rows = f.items.split('\n').map(l => l.split('|').map(s => s.trim())).filter(r => r[0]);
      return `<div class="stats-section bg-white">\n  <div class="stats-inner stagger">\n${rows.map(([v, l]) => `    <div class="stat-item">\n      <div class="stat-num">${v}</div>\n      <p class="stat-label">${escHtml(l || '')}</p>\n    </div>`).join('\n')}\n  </div>\n</div>`;
    },
  },
  'trust-bar': {
    label: 'Trust Bar', hint: 'A single centered line, e.g. "— Trusted by…".',
    fields: [{ key: 'text', label: 'Text', type: 'text', default: '— Trusted by B2B tech companies' }],
    render: f => `<div class="trust-bar bg-grey">\n  <p class="trust-label">${escHtml(f.text)}</p>\n</div>`,
  },
  'cards': {
    label: 'Card Grid (2 or 3 col)', hint: 'One card per line: number | title | body',
    fields: [
      { key: 'cols', label: 'Columns', type: 'select', options: ['2', '3'], default: '3' },
      { key: 'items', label: 'Cards (num | title | body, one per line)', type: 'textarea', default: '01 | Card title one | Description.\n02 | Card title two | Description.\n03 | Card title three | Description.' },
    ],
    render: f => {
      const rows = f.items.split('\n').map(l => l.split('|').map(s => s.trim())).filter(r => r[0]);
      return `<div class="card-grid-${f.cols} stagger" style="margin-top:48px;">\n${rows.map(([n, t, b]) => `  <div class="dark-card">\n    <p class="card-num">${escHtml(n)}</p>\n    <p class="card-title">${escHtml(t || '')}</p>\n    <p class="card-body">${escHtml(b || '')}</p>\n  </div>`).join('\n')}\n</div>`;
    },
  },
  'faq': {
    label: 'FAQ List', hint: 'One Q&A per pair of lines, separated by a blank line.',
    fields: [{ key: 'items', label: 'Q/A pairs (question, then answer, blank line between pairs)', type: 'textarea', default: 'Question one?\nAnswer one.\n\nQuestion two?\nAnswer two.' }],
    render: f => {
      const pairs = f.items.split(/\n\s*\n/).map(block => block.split('\n')).filter(p => p[0]);
      return `<div class="faq-list stagger">\n${pairs.map(([q, ...a]) => `  <div class="faq-item">\n    <p class="faq-q">${escHtml(q)}</p>\n    <p class="faq-a">${escHtml(a.join(' '))}</p>\n  </div>`).join('\n')}\n</div>`;
    },
  },
  'button-row': {
    label: 'Button Row', hint: 'Primary button, optional secondary (ghost) button.',
    fields: [
      { key: 'primaryText', label: 'Primary text', type: 'text', default: 'Book a 20-min call' },
      { key: 'primaryUrl', label: 'Primary URL', type: 'text', default: 'contact.html' },
      { key: 'secondaryText', label: 'Secondary text (optional)', type: 'text', default: '' },
      { key: 'secondaryUrl', label: 'Secondary URL', type: 'text', default: '' },
    ],
    render: f => `<div class="hero-ctas">\n  <a href="${escHtml(f.primaryUrl)}" class="btn-primary">${escHtml(f.primaryText)} →</a>${f.secondaryText ? `\n  <a href="${escHtml(f.secondaryUrl)}" class="btn-ghost">${escHtml(f.secondaryText)}</a>` : ''}\n</div>`,
  },
  'closing-cta': {
    label: 'Closing CTA Section', hint: 'The dark full-width CTA band used at the bottom of pages.',
    fields: [
      { key: 'headingHtml', label: 'Heading (HTML allowed)', type: 'text', default: 'Ready to <em>get started?</em>' },
      { key: 'body', label: 'Body', type: 'textarea', default: "No slide deck. We'll tell you honestly if we're a fit." },
      { key: 'buttonText', label: 'Button text', type: 'text', default: 'Book a 20-min call' },
      { key: 'buttonUrl', label: 'Button URL', type: 'text', default: 'contact.html' },
    ],
    render: f => `<section class="cta-section">\n  <canvas class="hero-bg-grid"></canvas>\n  <h2 class="cta-h reveal">${f.headingHtml}</h2>\n  <p class="cta-p reveal">${escHtml(f.body)}</p>\n  <a href="${escHtml(f.buttonUrl)}" class="btn-primary reveal">${escHtml(f.buttonText)}</a>\n</section>`,
  },
  'spacer': {
    label: 'Spacer', hint: 'Blank vertical space between sections.',
    fields: [{ key: 'size', label: 'Height', type: 'select', options: ['32px', '64px', '96px'], default: '64px' }],
    render: f => `<div style="height:${f.size}"></div>`,
  },
};

/* ------------------------------------------------------------
   App state
   ------------------------------------------------------------ */
const App = {
  branch: 'main',
  branches: [],
  pages: {},          // slug -> {path, sha, data, hero, main}
  navDoc: null,        // {sha, doc(DOMParser Document)}
  footerDoc: null,
  current: null,       // {type:'page', slug} | {type:'nav'} | {type:'footer'}
  activeTab: 'meta',
  assetCache: new Map(), // `${branch}:${path}` -> text | null
};

function setStatus(msg, kind) {
  const el = document.getElementById('status-line');
  el.textContent = msg || '';
  el.className = kind || '';
}
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* ------------------------------------------------------------
   Login
   ------------------------------------------------------------ */
async function tryLogin(token, owner, repo) {
  gh.token = token; gh.owner = owner; gh.repo = repo;
  await gh.whoami();
  await gh.getRepo(owner, repo);
  Settings.save({ token, owner, repo });
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').style.display = 'flex';
  document.getElementById('repo-label').textContent = `${owner}/${repo}`;
  await loadBranches();
  await loadBranchContent();
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const token = document.getElementById('login-token').value.trim();
  const owner = document.getElementById('login-owner').value.trim();
  const repo = document.getElementById('login-repo').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!token || !owner || !repo) { errEl.textContent = 'All three fields are required.'; errEl.style.display = 'block'; return; }
  try {
    document.getElementById('login-btn').disabled = true;
    document.getElementById('login-btn').textContent = 'Connecting…';
    await tryLogin(token, owner, repo);
  } catch (e) {
    errEl.textContent = 'Could not connect: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    document.getElementById('login-btn').disabled = false;
    document.getElementById('login-btn').textContent = 'Connect';
  }
});

document.getElementById('settings-btn').addEventListener('click', () => {
  if (confirm('Disconnect and clear the saved token from this browser?')) {
    Settings.clear();
    location.reload();
  }
});

(function boot() {
  const s = Settings.load();
  if (s && s.token && s.owner && s.repo) {
    document.getElementById('login-token').value = s.token;
    document.getElementById('login-owner').value = s.owner;
    document.getElementById('login-repo').value = s.repo;
    tryLogin(s.token, s.owner, s.repo).catch(e => {
      document.getElementById('login-error').textContent = 'Saved session failed: ' + e.message;
      document.getElementById('login-error').style.display = 'block';
    });
  }
})();

/* ------------------------------------------------------------
   Branch management
   ------------------------------------------------------------ */
async function loadBranches() {
  const list = await gh.listBranches(gh.owner, gh.repo);
  App.branches = list.map(b => b.name);
  const sel = document.getElementById('branch-select');
  sel.innerHTML = App.branches.map(n => `<option value="${n}"${n === App.branch ? ' selected' : ''}>${n}</option>`).join('');
}

document.getElementById('branch-select').addEventListener('change', async e => {
  App.branch = e.target.value;
  App.current = null;
  renderEditor();
  await loadBranchContent();
});

document.getElementById('new-draft-btn').addEventListener('click', () => {
  const suggestion = 'draft/' + new Date().toISOString().slice(0, 10) + '-' + Math.random().toString(36).slice(2, 6);
  openModal(`
    <div class="modal-title">Start a new draft</div>
    <p class="field-hint" style="margin-bottom:12px">Creates a new branch off <b>main</b>. Every save while you're on this branch commits there — nothing touches main until you publish.</p>
    <div class="field-group"><label class="field-label">Branch name</label><input class="field-input" id="new-branch-name" value="${suggestion}"></div>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="new-branch-confirm">Create draft</button></div>
  `);
  document.getElementById('new-branch-confirm').addEventListener('click', async () => {
    const name = document.getElementById('new-branch-name').value.trim();
    if (!name) return;
    closeModal();
    setStatus('creating branch…', 'busy');
    try {
      await gh.createBranch(gh.owner, gh.repo, name, 'main');
      await loadBranches();
      document.getElementById('branch-select').value = name;
      App.branch = name;
      App.current = null;
      renderEditor();
      await loadBranchContent();
      setStatus('draft ready', 'ok');
      toast(`Branch “${name}” created off main.`, 'success');
    } catch (e) {
      setStatus('error', 'error');
      toast('Could not create branch: ' + e.message, 'error');
    }
  });
});

document.getElementById('publish-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-title">Publish “${App.branch}” to main</div>
    <p class="field-hint" style="margin-bottom:12px">Merges this branch into <b>main</b> via the GitHub API. Cloudflare's existing deploy hook will pick it up and redeploy automatically — nothing else to do.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="publish-confirm">Merge &amp; publish</button></div>
  `);
  document.getElementById('publish-confirm').addEventListener('click', async () => {
    closeModal();
    setStatus('publishing…', 'busy');
    try {
      await gh.merge(gh.owner, gh.repo, 'main', App.branch, `Publish ${App.branch} to main via Blacfox CMS`);
      toast('Published to main. Cloudflare will redeploy shortly.', 'success');
      document.getElementById('branch-select').value = 'main';
      App.branch = 'main';
      App.current = null;
      renderEditor();
      await loadBranchContent();
      setStatus('published', 'ok');
    } catch (e) {
      setStatus('error', 'error');
      toast('Merge failed: ' + e.message, 'error');
    }
  });
});

function updatePublishBtnVisibility() {
  document.getElementById('publish-btn').style.display = (App.branch !== 'main') ? '' : 'none';
}

/* ------------------------------------------------------------
   Loading page/nav/footer content for the current branch
   ------------------------------------------------------------ */
async function loadBranchContent() {
  updatePublishBtnVisibility();
  setStatus('loading…', 'busy');
  try {
    const dir = await gh.getFile(gh.owner, gh.repo, 'pages', App.branch);
    const files = (dir && dir.dir ? dir.dir : []).filter(f => f.name.endsWith('.md'));
    App.pages = {};
    await Promise.all(files.map(async f => {
      const file = await gh.getFile(gh.owner, gh.repo, f.path, App.branch);
      const { data, body } = parseFrontmatter(file.text);
      const { hero, main } = splitBody(body);
      const slug = f.name.replace(/\.md$/, '');
      App.pages[slug] = { path: f.path, sha: file.sha, data, hero, main };
    }));

    const navFile = await gh.getFile(gh.owner, gh.repo, 'partials/nav.html', App.branch);
    App.navDoc = { sha: navFile.sha, doc: new DOMParser().parseFromString(navFile.text, 'text/html') };

    const footerFile = await gh.getFile(gh.owner, gh.repo, 'partials/footer.html', App.branch);
    App.footerDoc = { sha: footerFile.sha, doc: new DOMParser().parseFromString(footerFile.text, 'text/html') };

    renderSidebar();
    setStatus('', '');
  } catch (e) {
    setStatus('error', 'error');
    toast('Failed to load branch content: ' + e.message, 'error');
  }
}

/* ------------------------------------------------------------
   Sidebar / page tree
   ------------------------------------------------------------ */
function renderSidebar() {
  const tree = document.getElementById('page-tree');
  const slugs = Object.keys(App.pages).sort((a, b) => (a === 'index' ? -1 : b === 'index' ? 1 : a.localeCompare(b)));
  tree.innerHTML = slugs.map(slug => {
    const p = App.pages[slug];
    const active = App.current && App.current.type === 'page' && App.current.slug === slug;
    return `<div class="tree-item${active ? ' active' : ''}" data-slug="${slug}">
      ${slug === 'index' ? '<span class="home-star">★</span>' : ''}
      <span class="tree-item-label">${escHtml(p.data.title ? p.data.title.split('|')[0].trim() : slug)}</span>
      <span class="layout-badge">${p.data.layout || '?'}</span>
    </div>`;
  }).join('');
  tree.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', () => {
      App.current = { type: 'page', slug: el.dataset.slug };
      App.activeTab = 'meta';
      renderEditor();
      refreshPreview();
    });
  });

  ['nav', 'footer'].forEach(kind => {
    const el = document.getElementById(kind + '-tree-item');
    el.classList.toggle('active', App.current && App.current.type === kind);
  });
}
document.getElementById('nav-tree-item').addEventListener('click', () => { App.current = { type: 'nav' }; renderEditor(); refreshPreview(); });
document.getElementById('footer-tree-item').addEventListener('click', () => { App.current = { type: 'footer' }; renderEditor(); refreshPreview(); });

document.getElementById('add-page-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-title">Add a page</div>
    <div class="field-group"><label class="field-label">Slug (filename, e.g. "pricing")</label><input class="field-input" id="np-slug"></div>
    <div class="field-group"><label class="field-label">Nav label</label><input class="field-input" id="np-label"></div>
    <div class="field-group"><label class="field-label">Layout</label>
      <div class="radio-row"><div class="radio-btn on" data-v="inner">inner</div><div class="radio-btn" data-v="home">home</div></div>
    </div>
    <p class="field-hint">Adds pages/&lt;slug&gt;.md with starter frontmatter, and appends a nav link. You still need to write the hero + body content before publishing.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="np-confirm">Create page</button></div>
  `);
  const box = document.getElementById('modal-box');
  let layoutVal = 'inner';
  box.querySelectorAll('.radio-btn').forEach(b => b.addEventListener('click', () => {
    box.querySelectorAll('.radio-btn').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); layoutVal = b.dataset.v;
  }));
  document.getElementById('np-confirm').addEventListener('click', async () => {
    const slug = document.getElementById('np-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const label = document.getElementById('np-label').value.trim() || slug;
    if (!slug) return;
    if (App.pages[slug]) { toast('A page with that slug already exists.', 'error'); return; }
    closeModal();
    setStatus('creating page…', 'busy');
    try {
      const data = {
        title: `${label} | Blacfox`,
        description: '',
        cssFiles: ['assets/css/site.css'],
        bodyClass: 'theme-hero-dark',
        layout: layoutVal,
        canonical: `https://blacfox.com/${slug}.html`,
        pageScripts: [],
      };
      const hero = `<!-- HERO -->\n<section class="hero-section">\n  <canvas class="hero-bg-grid"></canvas>\n  <div class="section-inner">\n    <h1 class="hero-title">${escHtml(label)}</h1>\n  </div>\n</section>`;
      const main = `<!-- Add content sections here via the CMS body editor -->`;
      const content = serializeFrontmatter(data, joinBody(hero, main));
      const res = await gh.putFile(gh.owner, gh.repo, `pages/${slug}.md`, b64EncodeText(content), `Add ${slug} page via Blacfox CMS`, App.branch);
      App.pages[slug] = { path: `pages/${slug}.md`, sha: res.content.sha, data, hero, main };

      // Append nav link
      const navList = App.navDoc.doc.querySelector('.nav-links-pill');
      const a = App.navDoc.doc.createElement('a');
      a.setAttribute('href', `${slug}.html`);
      a.setAttribute('data-page', slug);
      a.textContent = label;
      navList.appendChild(a);
      await saveNav(`Add ${slug} to nav via Blacfox CMS`);

      renderSidebar();
      App.current = { type: 'page', slug };
      App.activeTab = 'meta';
      renderEditor();
      refreshPreview();
      setStatus('created', 'ok');
      toast(`Page “${slug}” created and added to nav.`, 'success');
    } catch (e) {
      setStatus('error', 'error');
      toast('Could not create page: ' + e.message, 'error');
    }
  });
});

/* ------------------------------------------------------------
   Modal helper
   ------------------------------------------------------------ */
function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('visible');
  document.getElementById('modal-box').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() { document.getElementById('modal-overlay').classList.remove('visible'); }
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });

/* ------------------------------------------------------------
   Editor: tabs + dispatch
   ------------------------------------------------------------ */
function renderEditor() {
  const tabsEl = document.getElementById('editor-tabs');
  const scroll = document.getElementById('editor-scroll');
  if (!App.current) {
    tabsEl.innerHTML = '';
    scroll.innerHTML = '<div id="editor-empty" class="callout-box" style="margin:20px">Pick a page, or Navigation / Footer, from the left to start editing.</div>';
    document.getElementById('preview-url').textContent = 'Select a page to preview';
    return;
  }
  if (App.current.type === 'page') {
    tabsEl.innerHTML = `<div class="editor-tab${App.activeTab === 'meta' ? ' active' : ''}" data-tab="meta">Meta</div><div class="editor-tab${App.activeTab === 'body' ? ' active' : ''}" data-tab="body">Body</div>`;
    tabsEl.querySelectorAll('.editor-tab').forEach(t => t.addEventListener('click', () => { App.activeTab = t.dataset.tab; renderEditor(); }));
    scroll.innerHTML = App.activeTab === 'meta' ? renderMetaTab() : renderBodyTab();
    wireTabHandlers();
  } else if (App.current.type === 'nav') {
    tabsEl.innerHTML = '';
    scroll.innerHTML = renderNavTab();
    wireNavHandlers();
  } else if (App.current.type === 'footer') {
    tabsEl.innerHTML = '';
    scroll.innerHTML = renderFooterTab();
    wireFooterHandlers();
  }
  renderSidebar();
}

/* ---------- Meta tab ---------- */
function renderMetaTab() {
  const slug = App.current.slug;
  const p = App.pages[slug];
  const d = p.data;
  return `
    <div class="callout-box">Editing <b>${slug}.md</b> on branch <b>${App.branch}</b>.</div>

    <div class="field-group"><label class="field-label">Title</label><input class="field-input" id="m-title" value="${escHtml(d.title || '')}"></div>
    <div class="field-group"><label class="field-label">Description</label><textarea class="field-textarea" id="m-description" style="min-height:70px">${escHtml(d.description || '')}</textarea></div>
    <div class="field-group"><label class="field-label">Canonical URL</label><input class="field-input" id="m-canonical" value="${escHtml(d.canonical || '')}"></div>

    <div class="section-divider"></div>
    <div class="section-title">Open Graph image</div>
    <div class="img-drop" id="og-drop">
      <div class="img-drop-lbl" id="og-drop-lbl">${d.ogImage ? d.ogImage + ' (loading preview…)' : 'Click or drop an image — commits to assets/og/' + slug + '.<ext> on save'}</div>
      <input type="file" id="og-file" accept="image/*">
    </div>

    <div class="section-divider"></div>
    <div class="section-title">Layout</div>
    <div class="radio-row">
      <div class="radio-btn${d.layout === 'home' ? ' on' : ''}" data-layout="home"${slug !== 'index' ? '' : ' style="pointer-events:none;opacity:.5"'}>home</div>
      <div class="radio-btn${d.layout === 'inner' ? ' on' : ''}" data-layout="inner"${slug === 'index' ? ' style="pointer-events:none;opacity:.5"' : ''}>inner</div>
    </div>
    <p class="field-hint">index.html is always "home"; every other page is "inner" — this is intentional per the site's two-layout design.</p>

    <div class="section-divider"></div>
    <div class="field-group"><label class="field-label">Body class</label><input class="field-input" id="m-bodyclass" value="${escHtml(d.bodyClass || '')}"></div>

    <div class="section-title" style="margin-top:14px">CSS files</div>
    <div class="array-list" id="m-cssfiles">${(d.cssFiles || []).map((v, i) => arrayRow('css', i, v)).join('')}</div>
    <button class="add-row-btn" id="m-css-add" style="margin-top:6px">+ Add CSS file</button>

    <div class="section-title" style="margin-top:14px">Page scripts</div>
    <div class="array-list" id="m-pagescripts">${(d.pageScripts || []).map((v, i) => arrayRow('js', i, v)).join('')}</div>
    <button class="add-row-btn" id="m-js-add" style="margin-top:6px">+ Add script</button>

    <div class="section-divider"></div>
    <button class="btn btn-primary" id="save-page-btn" style="width:100%;padding:10px">Save to ${App.branch}</button>
  `;
}
function arrayRow(kind, i, value) {
  return `<div class="array-row" data-kind="${kind}" data-i="${i}"><input class="field-input" value="${escHtml(value)}"><button class="icon-btn" data-remove="${kind}:${i}">✕</button></div>`;
}

function collectArrayList(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} .array-row input`)).map(i => i.value.trim()).filter(Boolean);
}

function wireTabHandlers() {
  if (App.activeTab === 'meta') {
    document.querySelectorAll('#editor-scroll .radio-btn[data-layout]').forEach(b => b.addEventListener('click', () => {
      if (b.style.pointerEvents === 'none') return;
      document.querySelectorAll('#editor-scroll .radio-btn[data-layout]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    }));
    document.getElementById('m-css-add').addEventListener('click', () => {
      document.getElementById('m-cssfiles').insertAdjacentHTML('beforeend', arrayRow('css', 999, ''));
      wireArrayRemove();
    });
    document.getElementById('m-js-add').addEventListener('click', () => {
      document.getElementById('m-pagescripts').insertAdjacentHTML('beforeend', arrayRow('js', 999, ''));
      wireArrayRemove();
    });
    wireArrayRemove();
    document.getElementById('og-drop').addEventListener('click', e => { if (e.target.tagName !== 'INPUT') document.getElementById('og-file').click(); });
    document.getElementById('og-file').addEventListener('change', onOgFilePicked);
    document.getElementById('save-page-btn').addEventListener('click', savePageMeta);
    loadOgThumbnail();
  } else {
    document.getElementById('save-body-btn').addEventListener('click', savePageBody);
    document.getElementById('insert-section-btn').addEventListener('click', openInsertSectionModal);
  }
}
function wireArrayRemove() {
  document.querySelectorAll('#editor-scroll [data-remove]').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.array-row').remove());
  });
}

async function loadOgThumbnail() {
  const p = App.pages[App.current.slug];
  if (!p.data.ogImage) return;
  const uri = await fetchAssetDataUri(p.data.ogImage);
  const drop = document.getElementById('og-drop');
  if (!drop) return; // user navigated away before this resolved
  const lbl = document.getElementById('og-drop-lbl');
  if (uri) {
    drop.insertAdjacentHTML('afterbegin', `<img src="${uri}">`);
    if (lbl) lbl.textContent = p.data.ogImage;
  } else if (lbl) {
    lbl.textContent = p.data.ogImage + ' (file not found in repo)';
  }
}

let pendingOgUpload = null;
function onOgFilePicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingOgUpload = { name: file.name, bytes: new Uint8Array(reader.result) };
    const blobUrl = URL.createObjectURL(file);
    document.querySelector('#og-drop img')?.remove();
    document.getElementById('og-drop').insertAdjacentHTML('afterbegin', `<img src="${blobUrl}">`);
    document.querySelector('.img-drop-lbl').textContent = file.name + ' (will upload on save)';
  };
  reader.readAsArrayBuffer(file);
}

async function savePageMeta() {
  const slug = App.current.slug;
  const p = App.pages[slug];
  const layoutBtn = document.querySelector('#editor-scroll .radio-btn[data-layout].on');
  const newData = {
    ...p.data,
    title: document.getElementById('m-title').value.trim(),
    description: document.getElementById('m-description').value.trim(),
    canonical: document.getElementById('m-canonical').value.trim(),
    layout: layoutBtn ? layoutBtn.dataset.layout : p.data.layout,
    bodyClass: document.getElementById('m-bodyclass').value.trim(),
    cssFiles: collectArrayList('m-cssfiles'),
    pageScripts: collectArrayList('m-pagescripts'),
  };
  setStatus('saving…', 'busy');
  try {
    if (pendingOgUpload) {
      const ext = (pendingOgUpload.name.match(/\.\w+$/) || ['.png'])[0];
      const ogPath = `assets/og/${slug}${ext}`;
      const existing = await gh.getFile(gh.owner, gh.repo, ogPath, App.branch);
      await gh.putFile(gh.owner, gh.repo, ogPath, bytesToB64(pendingOgUpload.bytes), `Update OG image for ${slug} via Blacfox CMS`, App.branch, existing ? existing.sha : undefined);
      newData.ogImage = ogPath;
      pendingOgUpload = null;
    }
    await commitPage(slug, newData, p.hero, p.main, `Update ${slug} meta via Blacfox CMS`);
    toast(`Saved ${slug}.md`, 'success');
    setStatus('saved', 'ok');
    refreshPreview();
  } catch (e) {
    setStatus('error', 'error');
    toast('Save failed: ' + e.message, 'error');
  }
}

/* ---------- Body tab ---------- */
function renderBodyTab() {
  const slug = App.current.slug;
  const p = App.pages[slug];
  return `
    <div class="callout-box">Existing page bodies are hand-authored HTML — edited here as raw source so nothing is lost or restyled. Use “+ Insert section” to add new, consistently-styled sections without hand-writing markup.</div>

    <div class="field-group">
      <label class="field-label">Hero <span style="color:#444">(before the content wrap)</span></label>
      <textarea class="field-textarea tall" id="b-hero">${escHtml(p.hero)}</textarea>
    </div>

    <div class="field-group">
      <label class="field-label">Main content <span style="color:#444">(after the content wrap, before the footer)</span></label>
      <textarea class="field-textarea tall" id="b-main" style="min-height:360px">${escHtml(p.main)}</textarea>
    </div>

    <button class="btn btn-ghost" id="insert-section-btn" style="width:100%;margin-bottom:10px">+ Insert section</button>
    <button class="btn btn-primary" id="save-body-btn" style="width:100%;padding:10px">Save to ${App.branch}</button>
  `;
}

async function savePageBody() {
  const slug = App.current.slug;
  const p = App.pages[slug];
  const hero = document.getElementById('b-hero').value;
  const main = document.getElementById('b-main').value;
  setStatus('saving…', 'busy');
  try {
    await commitPage(slug, p.data, hero, main, `Update ${slug} body via Blacfox CMS`);
    toast(`Saved ${slug}.md`, 'success');
    setStatus('saved', 'ok');
    refreshPreview();
  } catch (e) {
    setStatus('error', 'error');
    toast('Save failed: ' + e.message, 'error');
  }
}

async function commitPage(slug, data, hero, main, message) {
  const p = App.pages[slug];
  const content = serializeFrontmatter(data, joinBody(hero, main));
  const res = await gh.putFile(gh.owner, gh.repo, p.path, b64EncodeText(content), message, App.branch, p.sha);
  App.pages[slug] = { path: p.path, sha: res.content.sha, data, hero, main };
  renderSidebar();
}

function openInsertSectionModal() {
  const items = Object.entries(COMPONENTS).map(([key, c]) => `<div class="comp-picker-item" data-comp="${key}"><strong>${c.label}</strong>${c.hint}</div>`).join('');
  openModal(`<div class="modal-title">Insert section</div><div class="comp-picker-grid">${items}</div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button></div>`);
  document.querySelectorAll('.comp-picker-item').forEach(el => el.addEventListener('click', () => openComponentForm(el.dataset.comp)));
}

function openComponentForm(key) {
  const c = COMPONENTS[key];
  const fieldsHtml = c.fields.map(f => {
    if (f.type === 'textarea') return `<div class="field-group"><label class="field-label">${f.label}</label><textarea class="field-textarea" id="cf-${f.key}" style="min-height:90px">${escHtml(f.default)}</textarea></div>`;
    if (f.type === 'select') return `<div class="field-group"><label class="field-label">${f.label}</label><select class="field-select" id="cf-${f.key}">${f.options.map(o => `<option${o === f.default ? ' selected' : ''}>${o}</option>`).join('')}</select></div>`;
    return `<div class="field-group"><label class="field-label">${f.label}</label><input class="field-input" id="cf-${f.key}" value="${escHtml(f.default)}"></div>`;
  }).join('');
  openModal(`<div class="modal-title">${c.label}</div>${fieldsHtml}<div class="modal-actions"><button class="btn btn-ghost" data-close>Back</button><button class="btn btn-primary" id="cf-insert">Insert</button></div>`);
  document.getElementById('cf-insert').addEventListener('click', () => {
    const values = {};
    c.fields.forEach(f => { values[f.key] = document.getElementById('cf-' + f.key).value; });
    const html = c.render(values);
    const textarea = document.getElementById('b-main');
    const pos = textarea.selectionStart ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, pos) + (pos > 0 ? '\n\n' : '') + html + '\n\n' + textarea.value.slice(pos);
    closeModal();
    toast(`${c.label} inserted — remember to Save.`, 'success');
  });
}

/* ---------- Nav tab ---------- */
function getNavLinks() {
  const navEl = App.navDoc.doc.querySelector('.nav-links-pill');
  return Array.from(navEl.querySelectorAll('a')).map(a => ({ label: a.textContent, href: a.getAttribute('href') }));
}
function renderNavTab() {
  const links = getNavLinks();
  return `
    <div class="callout-box">Editing <b>partials/nav.html</b> — shared by all 9 pages. Reordering here reorders the nav on every page at once.</div>
    <div class="array-list" id="nav-links">${links.map((l, i) => navRow(l, i, links.length)).join('')}</div>
    <button class="add-row-btn" id="nav-add-btn" style="margin-top:8px">+ Add link</button>
    <div class="section-divider"></div>
    <button class="btn btn-primary" id="save-nav-btn" style="width:100%;padding:10px">Save to ${App.branch}</button>
  `;
}
function navRow(l, i, total) {
  return `<div class="chrome-item-card" data-i="${i}">
    <div class="chrome-item-head"><span class="chrome-item-badge">Link ${i + 1}</span>
      <div class="move-btns"><button data-move="up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-move="down" ${i === total - 1 ? 'disabled' : ''}>↓</button><button data-remove-nav>✕</button></div>
    </div>
    <input class="field-input nav-label" value="${escHtml(l.label)}" placeholder="Label">
    <input class="field-input nav-href" value="${escHtml(l.href)}" placeholder="href (e.g. about.html)">
  </div>`;
}
function wireNavHandlers() {
  wireChromeMoveRemove('#nav-links', renderNavList);
  document.getElementById('nav-add-btn').addEventListener('click', () => {
    document.getElementById('nav-links').insertAdjacentHTML('beforeend', navRow({ label: 'New Link', href: '#' }, document.querySelectorAll('#nav-links .chrome-item-card').length, 999));
    renderNavList();
  });
  document.getElementById('save-nav-btn').addEventListener('click', saveNavFromForm);
}
function renderNavList() {
  const cards = document.querySelectorAll('#nav-links .chrome-item-card');
  cards.forEach((c, i) => {
    c.querySelector('.chrome-item-badge').textContent = `Link ${i + 1}`;
    const up = c.querySelector('[data-move="up"]'), down = c.querySelector('[data-move="down"]');
    up.disabled = i === 0; down.disabled = i === cards.length - 1;
  });
  wireChromeMoveRemove('#nav-links', renderNavList);
}
function wireChromeMoveRemove(containerSel, rerender) {
  document.querySelectorAll(`${containerSel} .chrome-item-card`).forEach(card => {
    const upBtn = card.querySelector('[data-move="up"]');
    const downBtn = card.querySelector('[data-move="down"]');
    const rmBtn = card.querySelector('[data-remove-nav],[data-remove-col],[data-remove-link],[data-remove-social],[data-remove-line]');
    if (upBtn) upBtn.onclick = () => { const prev = card.previousElementSibling; if (prev) card.parentNode.insertBefore(card, prev); rerender(); };
    if (downBtn) downBtn.onclick = () => { const next = card.nextElementSibling; if (next) card.parentNode.insertBefore(next, card); rerender(); };
    if (rmBtn) rmBtn.onclick = () => { card.remove(); rerender(); };
  });
}
async function saveNavFromForm() {
  const rows = Array.from(document.querySelectorAll('#nav-links .chrome-item-card')).map(c => ({
    label: c.querySelector('.nav-label').value.trim(),
    href: c.querySelector('.nav-href').value.trim(),
  }));
  const navEl = App.navDoc.doc.querySelector('.nav-links-pill');
  navEl.innerHTML = '';
  rows.forEach(r => {
    const a = App.navDoc.doc.createElement('a');
    a.setAttribute('href', r.href);
    a.setAttribute('data-page', r.href.replace(/\.html$/, ''));
    a.textContent = r.label;
    navEl.appendChild(a);
  });
  await saveNav('Update nav via Blacfox CMS');
  toast('Nav saved.', 'success');
  refreshPreview();
}
async function saveNav(message) {
  setStatus('saving…', 'busy');
  try {
    const html = App.navDoc.doc.body.innerHTML.trim();
    const res = await gh.putFile(gh.owner, gh.repo, 'partials/nav.html', b64EncodeText(html + '\n'), message, App.branch, App.navDoc.sha);
    App.navDoc.sha = res.content.sha;
    setStatus('saved', 'ok');
  } catch (e) {
    setStatus('error', 'error');
    toast('Nav save failed: ' + e.message, 'error');
    throw e;
  }
}

/* ---------- Footer tab ---------- */
function getFooterModel() {
  const doc = App.footerDoc.doc;
  const tagline = doc.querySelector('.footer-brand > p')?.textContent || '';
  const socials = Array.from(doc.querySelectorAll('.footer-socials a.soc')).map(a => ({ label: a.getAttribute('aria-label') || '', href: a.getAttribute('href') || '', svg: a.innerHTML }));
  const columns = Array.from(doc.querySelectorAll('.footer-col')).map(col => ({
    heading: col.querySelector('h5')?.textContent || '',
    links: Array.from(col.querySelectorAll('ul li a')).map(a => ({ label: a.textContent, href: a.getAttribute('href') || '' })),
  }));
  const bottom = Array.from(doc.querySelectorAll('.footer-bottom p')).map(p => p.textContent);
  return { tagline, socials, columns, bottom };
}
function renderFooterTab() {
  const m = getFooterModel();
  return `
    <div class="callout-box">Editing <b>partials/footer.html</b> — shared by all 9 pages.</div>
    <div class="field-group"><label class="field-label">Tagline</label><textarea class="field-textarea" id="f-tagline" style="min-height:60px">${escHtml(m.tagline)}</textarea></div>

    <div class="section-title">Social links</div>
    <div class="array-list" id="f-socials">${m.socials.map((s, i) => `<div class="chrome-item-card" data-i="${i}"><div class="chrome-item-head"><span class="chrome-item-badge">Social ${i + 1}</span><button data-remove-social class="icon-btn">✕</button></div><input class="field-input f-soc-label" value="${escHtml(s.label)}" placeholder="Label (aria-label)"><input class="field-input f-soc-href" value="${escHtml(s.href)}" placeholder="URL"></div>`).join('')}</div>
    <button class="add-row-btn" id="f-social-add" style="margin-top:6px">+ Add social link</button>

    <div class="section-divider"></div>
    <div class="section-title">Columns</div>
    <div id="f-columns">${m.columns.map((col, i) => footerColumnCard(col, i)).join('')}</div>
    <button class="add-row-btn" id="f-col-add" style="margin-top:6px">+ Add column</button>

    <div class="section-divider"></div>
    <div class="section-title">Bottom line(s)</div>
    <div class="array-list" id="f-bottom">${m.bottom.map((t, i) => `<div class="array-row"><input class="field-input f-bottom-line" value="${escHtml(t)}"><button class="icon-btn" data-remove-line>✕</button></div>`).join('')}</div>
    <button class="add-row-btn" id="f-bottom-add" style="margin-top:6px">+ Add line</button>

    <div class="section-divider"></div>
    <button class="btn btn-primary" id="save-footer-btn" style="width:100%;padding:10px">Save to ${App.branch}</button>
  `;
}
function footerColumnCard(col, i) {
  return `<div class="chrome-item-card" data-i="${i}">
    <div class="chrome-item-head"><span class="chrome-item-badge">Column ${i + 1}</span><button data-remove-col class="icon-btn">✕</button></div>
    <input class="field-input f-col-heading" value="${escHtml(col.heading)}" placeholder="Column heading">
    <div class="array-list f-col-links">${col.links.map(l => footerLinkRow(l)).join('')}</div>
    <button class="add-row-btn f-col-link-add" style="margin-top:4px">+ Add link</button>
  </div>`;
}
function footerLinkRow(l) {
  return `<div class="array-row"><input class="field-input f-col-link-label" value="${escHtml(l.label)}" placeholder="Label" style="flex:1"><input class="field-input f-col-link-href" value="${escHtml(l.href)}" placeholder="href" style="flex:1"><button class="icon-btn" data-remove-link>✕</button></div>`;
}
function wireFooterHandlers() {
  wireFooterRemovals();
  document.getElementById('f-social-add').addEventListener('click', () => {
    document.getElementById('f-socials').insertAdjacentHTML('beforeend', `<div class="chrome-item-card"><div class="chrome-item-head"><span class="chrome-item-badge">Social</span><button data-remove-social class="icon-btn">✕</button></div><input class="field-input f-soc-label" placeholder="Label (aria-label)"><input class="field-input f-soc-href" placeholder="URL"></div>`);
    wireFooterRemovals();
  });
  document.getElementById('f-col-add').addEventListener('click', () => {
    document.getElementById('f-columns').insertAdjacentHTML('beforeend', footerColumnCard({ heading: 'New Column', links: [] }, 999));
    wireFooterRemovals();
  });
  document.getElementById('f-bottom-add').addEventListener('click', () => {
    document.getElementById('f-bottom').insertAdjacentHTML('beforeend', `<div class="array-row"><input class="field-input f-bottom-line"><button class="icon-btn" data-remove-line>✕</button></div>`);
    wireFooterRemovals();
  });
  document.getElementById('save-footer-btn').addEventListener('click', saveFooterFromForm);
}
function wireFooterRemovals() {
  document.querySelectorAll('[data-remove-social],[data-remove-col],[data-remove-line]').forEach(btn => {
    btn.onclick = () => btn.closest('.chrome-item-card,.array-row').remove();
  });
  document.querySelectorAll('.f-col-link-add').forEach(btn => {
    btn.onclick = () => { btn.previousElementSibling.insertAdjacentHTML('beforeend', footerLinkRow({ label: '', href: '' })); wireFooterRemovals(); };
  });
  document.querySelectorAll('[data-remove-link]').forEach(btn => { btn.onclick = () => btn.closest('.array-row').remove(); });
}
async function saveFooterFromForm() {
  const doc = App.footerDoc.doc;
  doc.querySelector('.footer-brand > p').textContent = document.getElementById('f-tagline').value;

  const socialsEl = doc.querySelector('.footer-socials');
  const existingSocials = getFooterModel().socials;
  socialsEl.innerHTML = '';
  Array.from(document.querySelectorAll('#f-socials .chrome-item-card')).forEach((card, i) => {
    const label = card.querySelector('.f-soc-label').value.trim();
    const href = card.querySelector('.f-soc-href').value.trim();
    const a = doc.createElement('a');
    a.className = 'soc'; a.setAttribute('href', href); a.setAttribute('aria-label', label);
    a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener');
    a.innerHTML = (existingSocials[i] && existingSocials[i].svg) || '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M5 7.5h5M8 5l2.5 2.5L8 10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    socialsEl.appendChild(a);
  });

  const gridEl = doc.querySelector('.footer-grid');
  Array.from(gridEl.querySelectorAll('.footer-col')).forEach(c => c.remove());
  Array.from(document.querySelectorAll('#f-columns .chrome-item-card')).forEach(card => {
    const heading = card.querySelector('.f-col-heading').value.trim();
    const links = Array.from(card.querySelectorAll('.f-col-link-label')).map((inp, i) => ({
      label: inp.value.trim(),
      href: card.querySelectorAll('.f-col-link-href')[i].value.trim(),
    }));
    const col = doc.createElement('div'); col.className = 'footer-col';
    const h5 = doc.createElement('h5'); h5.textContent = heading; col.appendChild(h5);
    const ul = doc.createElement('ul');
    links.forEach(l => { const li = doc.createElement('li'); const a = doc.createElement('a'); a.setAttribute('href', l.href); a.textContent = l.label; li.appendChild(a); ul.appendChild(li); });
    col.appendChild(ul);
    gridEl.appendChild(col);
  });

  const bottomLines = Array.from(document.querySelectorAll('#f-bottom .f-bottom-line')).map(i => i.value);
  const bottomEl = doc.querySelector('.footer-bottom');
  bottomEl.innerHTML = '';
  bottomLines.forEach(t => { const p = doc.createElement('p'); p.textContent = t; bottomEl.appendChild(p); });

  setStatus('saving…', 'busy');
  try {
    const html = doc.body.innerHTML.trim();
    const res = await gh.putFile(gh.owner, gh.repo, 'partials/footer.html', b64EncodeText(html + '\n'), 'Update footer via Blacfox CMS', App.branch, App.footerDoc.sha);
    App.footerDoc.sha = res.content.sha;
    setStatus('saved', 'ok');
    toast('Footer saved.', 'success');
    refreshPreview();
  } catch (e) {
    setStatus('error', 'error');
    toast('Footer save failed: ' + e.message, 'error');
  }
}

/* ------------------------------------------------------------
   Live preview — fetches this branch's real partials/assets and
   assembles the same HTML build.js would produce, then inlines
   CSS/JS so it renders correctly inside a sandboxed iframe.
   ------------------------------------------------------------ */
async function fetchAssetText(path) {
  const key = `text:${App.branch}:${path}`;
  if (App.assetCache.has(key)) return App.assetCache.get(key);
  const b64 = await gh.getFileBytesB64(gh.owner, gh.repo, path, App.branch).catch(() => null);
  const text = b64 != null ? b64DecodeText(b64) : null;
  App.assetCache.set(key, text);
  return text;
}

async function fetchAssetDataUri(path) {
  const key = `datauri:${App.branch}:${path}`;
  if (App.assetCache.has(key)) return App.assetCache.get(key);
  const b64 = await gh.getFileBytesB64(gh.owner, gh.repo, path, App.branch).catch(() => null);
  const uri = b64 != null ? `data:${guessMime(path)};base64,${b64}` : null;
  App.assetCache.set(key, uri);
  return uri;
}

// Every repo asset the rendered page references by relative path (img/link
// src|href, and any CSS url(...) — including ones inside the <style> blocks
// just inlined above) gets swapped for a data: URI fetched via the
// authenticated API. This is what makes the preview work against a PRIVATE
// repo: plain raw.githubusercontent.com links 404 for anyone unauthenticated,
// which is why the logo/background images were breaking.
async function inlineAssetRefs(html) {
  const re = /(?:src|href)="(assets\/[^"]+)"|url\((['"]?)(assets\/[^'")]+)\2\)/g;
  const paths = new Set();
  let m;
  while ((m = re.exec(html))) paths.add(m[1] || m[3]);
  for (const path of paths) {
    const uri = await fetchAssetDataUri(path);
    if (uri) html = html.split(path).join(uri);
  }
  return html;
}

async function buildPreviewHTML(slug) {
  const p = App.pages[slug];
  const [headText, navFile, footerFile] = await Promise.all([
    fetchAssetText('partials/head.html'),
    gh.getFile(gh.owner, gh.repo, 'partials/nav.html', App.branch),
    gh.getFile(gh.owner, gh.repo, 'partials/footer.html', App.branch),
  ]);
  let html = renderPageClient(p.data, p.hero, p.main, { head: headText, nav: navFile.text.trim(), footer: footerFile.text.trim() });

  // Inline local stylesheets (text)
  const linkRe = /<link rel="stylesheet" href="([^"]+)">/g;
  const linkMatches = [...html.matchAll(linkRe)];
  for (const m of linkMatches) {
    const href = m[1];
    if (/^https?:/.test(href)) continue; // external (Google Fonts) — leave as-is, real MIME type
    const text = await fetchAssetText(href);
    html = html.replace(m[0], text != null ? `<style>/* ${href} */\n${text}\n</style>` : '');
  }
  // Inline local scripts (text)
  const scriptRe = /<script src="([^"]+)"[^>]*><\/script>/g;
  const scriptMatches = [...html.matchAll(scriptRe)];
  for (const m of scriptMatches) {
    const src = m[1];
    if (/^https?:/.test(src)) continue;
    const text = await fetchAssetText(src);
    html = html.replace(m[0], text != null ? `<script>${text}</script>` : '');
  }
  // Inline every remaining relative asset reference (images, fonts, SVG
  // backgrounds — in the markup AND inside the CSS just inlined above) as a
  // data: URI, fetched through the authenticated API rather than a public
  // raw-content URL.
  html = await inlineAssetRefs(html);
  return html;
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(doRefreshPreview, 250);
}
async function doRefreshPreview() {
  if (!App.current || App.current.type !== 'page') {
    document.getElementById('preview-empty').style.display = 'flex';
    document.getElementById('preview-frame').style.display = 'none';
    document.getElementById('preview-url').textContent = App.current ? `${App.current.type} (no page preview)` : 'Select a page to preview';
    return;
  }
  const slug = App.current.slug;
  document.getElementById('preview-url').textContent = `${slug}.html — ${App.branch}`;
  try {
    const html = await buildPreviewHTML(slug);
    const frame = document.getElementById('preview-frame');
    frame.srcdoc = html;
    frame.style.display = '';
    document.getElementById('preview-empty').style.display = 'none';
  } catch (e) {
    toast('Preview failed: ' + e.message, 'error');
  }
}
document.getElementById('refresh-preview-btn').addEventListener('click', refreshPreview);
