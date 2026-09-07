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

  // The Contents API's single-shot PUT below can't reliably take inline
  // base64 content much above ~1MB -- the same real ceiling already noted
  // on the read side in getFileBytesB64 (fonts.css, ~1.7MB, needed the Git
  // Blob API there too). An uncompressed PNG clears this constantly, which
  // is why an image upload can fail with no useful error while a smaller
  // JPG of the same photo works fine. ~1,400,000 base64 chars ≈ 1MB raw.
  LARGE_FILE_B64_THRESHOLD: 1400000,

  async putFile(owner, repo, path, contentB64, message, branch, sha) {
    if (contentB64.length > this.LARGE_FILE_B64_THRESHOLD) {
      return this.putLargeFile(owner, repo, path, contentB64, message, branch);
    }
    const body = { message, content: contentB64, branch };
    if (sha) body.sha = sha;
    return this.req(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  // Assembles the same result by hand via the lower-level Git Data API:
  // create a blob for the content, graft it into a new tree off the
  // branch's current commit, commit that tree, then fast-forward the
  // branch ref to it. Returns {content:{sha}} to match putFile's normal
  // shape -- callers use that sha as the "sha" param on the *next* update
  // to the same file (optimistic concurrency), same as the Contents API's
  // response would give them.
  async putLargeFile(owner, repo, path, contentB64, message, branch) {
    const blob = await this.req(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: contentB64, encoding: 'base64' }),
    });
    const ref = await this.getRef(owner, repo, branch);
    const baseCommit = await this.req(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    const tree = await this.req(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
      }),
    });
    const newCommit = await this.req(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
    });
    await this.req(`/repos/${owner}/${repo}/git/refs/${encodeURIComponent('heads/' + branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha }),
    });
    return { content: { sha: blob.sha } };
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
<script src="assets/js/nav.js"></script>
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
  'callout-box': {
    label: 'Callout Box', hint: 'A short, bold statement in an orange-bordered box, for punching up one key line mid-section.',
    fields: [{ key: 'html', label: 'Text (HTML allowed for <em>)', type: 'textarea', default: 'A short, memorable statement goes here.' }],
    render: f => `<div class="callout-box reveal">\n  <p>${f.html}</p>\n</div>`,
  },
  'pull-quote': {
    label: 'Pull Quote', hint: 'An optional eyebrow label above a large italic quote line.',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow (optional)', type: 'text', default: '' },
      { key: 'html', label: 'Quote text (HTML allowed for <em>)', type: 'textarea', default: 'A memorable line worth pulling out on its own.' },
    ],
    render: f => `<div class="pull-quote-block reveal">\n${f.eyebrow ? `  <p class="pull-quote-eyebrow">${escHtml(f.eyebrow)}</p>\n` : ''}  <p class="pull-quote-text">${f.html}</p>\n</div>`,
  },
  'testimonial': {
    label: 'Testimonial', hint: 'A client quote with a name and role/company.',
    fields: [
      { key: 'quoteHtml', label: 'Quote (HTML allowed for <em>)', type: 'textarea', default: '“A memorable client quote goes here.”' },
      { key: 'name', label: 'Name', type: 'text', default: 'Full Name' },
      { key: 'role', label: 'Role / Company', type: 'text', default: 'Title, Company' },
    ],
    render: f => `<div class="testimonial-card reveal">\n  <p class="testimonial-quote">${f.quoteHtml}</p>\n  <div class="testimonial-author">\n    <p class="testimonial-name">${escHtml(f.name)}</p>\n    <p class="testimonial-role">${escHtml(f.role)}</p>\n  </div>\n</div>`,
  },
  'service-card': {
    label: 'Service / Offering Card', hint: 'One packaged service or offering, matching the cards on the Services page.',
    fields: [
      { key: 'name', label: 'Eyebrow (e.g. "Service 01")', type: 'text', default: 'Service 01' },
      { key: 'headlineHtml', label: 'Headline (HTML allowed for <em>)', type: 'text', default: 'Service name' },
      { key: 'leadHtml', label: 'Lead line (HTML allowed for <strong>/<em>)', type: 'textarea', default: 'One-line description of the outcome this service delivers.' },
      { key: 'includesTitle', label: 'List heading', type: 'text', default: "What's included" },
      { key: 'features', label: 'Features (one per line, HTML allowed)', type: 'textarea', default: 'First deliverable\nSecond deliverable\nThird deliverable' },
      { key: 'meta', label: 'Footer meta line (e.g. "12 WEEKS · PAID ON OUTCOMES")', type: 'text', default: 'PAID ON OUTCOMES' },
    ],
    render: f => {
      const feats = f.features.split('\n').map(s => s.trim()).filter(Boolean);
      return `<div class="service-card reveal">\n  <p class="service-name">${escHtml(f.name)}</p>\n  <h2 class="service-headline">${f.headlineHtml}</h2>\n  <p class="service-lead">${f.leadHtml}</p>\n  <p class="service-includes-title">${escHtml(f.includesTitle)}</p>\n  <ul class="service-list">\n${feats.map(x => `    <li>${x}</li>`).join('\n')}\n  </ul>\n  <p class="service-meta">${escHtml(f.meta)}</p>\n</div>`;
    },
  },
  'case-study': {
    label: 'Case Study Card', hint: 'A proof panel: headline, body copy, a CTA link, and a strip of stat numbers.',
    fields: [
      { key: 'badge', label: 'Badge text', type: 'text', default: 'Proof, not promises' },
      { key: 'meta', label: 'Small eyebrow line (optional)', type: 'text', default: '' },
      { key: 'headlineHtml', label: 'Headline (HTML allowed for <em>)', type: 'text', default: 'Case study headline goes here.' },
      { key: 'body', label: 'Body', type: 'textarea', default: 'Describe the result and how it was achieved.' },
      { key: 'ctaText', label: 'CTA text', type: 'text', default: 'Ask us on the call' },
      { key: 'ctaUrl', label: 'CTA URL', type: 'text', default: 'contact.html' },
      { key: 'stats', label: 'Stats (value | label, one per line, up to 4)', type: 'textarea', default: '10:1 | pipeline ACV return\n15+ | years experience' },
    ],
    render: f => {
      const rows = f.stats.split('\n').map(l => l.split('|').map(s => s.trim())).filter(r => r[0]).slice(0, 4);
      return `<div class="case-study-card reveal" style="padding:40px 48px;">\n  <div class="case-study-body">\n    <div class="case-badge">${escHtml(f.badge)}</div>\n${f.meta ? `    <p class="case-meta">${escHtml(f.meta)}</p>\n` : ''}    <h3 class="case-headline">${f.headlineHtml}</h3>\n    <p style="font-size:15px;color:var(--muted);line-height:1.7;max-width:640px;">${escHtml(f.body)}</p>\n    <div style="margin-top:32px;">\n      <a href="${escHtml(f.ctaUrl)}" class="btn-ghost">${escHtml(f.ctaText)} →</a>\n    </div>\n  </div>\n  <div class="case-stats-strip">\n${rows.map(([v, l]) => `    <div><p class="case-stat-num">${escHtml(v)}</p><p class="case-stat-label">${escHtml(l || '')}</p></div>`).join('\n')}\n  </div>\n</div>`;
    },
  },
  'mistakes-grid': {
    label: 'Numbered Mistakes Grid', hint: 'A grid of big-numeral Q&A cards (e.g. "5 common mistakes") — visually distinct from the FAQ accordion. One Q&A per pair of lines, blank line between pairs.',
    fields: [{ key: 'items', label: 'Q/A pairs (question, then answer, blank line between pairs)', type: 'textarea', default: 'Common mistake one?\nWhy it happens and how to avoid it.\n\nCommon mistake two?\nWhy it happens and how to avoid it.' }],
    render: f => {
      const pairs = f.items.split(/\n\s*\n/).map(block => block.split('\n')).filter(p => p[0]);
      return `<div class="mistakes-grid reveal">\n${pairs.map(([q, ...a], i) => `  <div class="mistake-card">\n    <div class="mistake-bg-num">${i + 1}</div>\n    <div class="mistake-num">Mistake ${String(i + 1).padStart(2, '0')}</div>\n    <div class="mistake-q">${escHtml(q)}</div>\n    <div class="mistake-a">${escHtml(a.join(' '))}</div>\n  </div>`).join('\n')}\n</div>`;
    },
  },
};

/* Curated block vocabulary for article bodies -- narrower than the full
   marketing COMPONENTS set (no stats/trust-bar/faq/etc., nothing that
   assumes a landing-page layout) since these are written by non-technical
   staff composing a blog post. 'image' has no fields/render -- it's
   special-cased in the insert-section picker to open an upload dialog
   instead of the generic field-form modal. */
const BLOG_COMPONENTS = {
  'heading': {
    label: 'Heading', hint: 'A section heading within the article.',
    fields: [{ key: 'html', label: 'Heading (HTML allowed for <em>)', type: 'text', default: 'A heading' }],
    render: f => `<h2>${f.html}</h2>`,
  },
  'subheading': {
    label: 'Subheading', hint: 'A smaller heading within the article.',
    fields: [{ key: 'html', label: 'Subheading (HTML allowed for <em>)', type: 'text', default: 'A subheading' }],
    render: f => `<h3>${f.html}</h3>`,
  },
  'paragraph': {
    label: 'Paragraph', hint: '',
    fields: [{ key: 'html', label: 'Text', type: 'textarea', default: 'Write your paragraph here.' }],
    render: f => `<p>${f.html}</p>`,
  },
  'image': { label: 'Image', hint: 'Upload a JPG or PNG from your computer.', fields: [], render: () => '' },
  'quote': {
    label: 'Pull Quote', hint: 'A highlighted quote or callout.',
    fields: [{ key: 'html', label: 'Quote text', type: 'textarea', default: 'A memorable quote goes here.' }],
    render: f => `<blockquote>${f.html}</blockquote>`,
  },
  'button-row': COMPONENTS['button-row'],
};

/* ------------------------------------------------------------
   App state
   ------------------------------------------------------------ */
const App = {
  branch: 'main',
  branches: [],
  pages: {},          // slug -> {path, sha, data, hero, main}
  articles: {},        // slug -> {path, sha, data, body}
  navDoc: null,        // {sha, doc(DOMParser Document)}
  footerDoc: null,
  current: null,       // {type:'page'|'article', slug} | {type:'nav'} | {type:'footer'}
  activeTab: 'meta',
  assetCache: new Map(), // `${branch}:${path}` -> text | null
  previewEditMode: false,
};

const ARTICLE_META_FIELD_ORDER = ['title', 'description', 'author', 'date', 'banner', 'cssFiles', 'bodyClass', 'canonical', 'pageScripts'];
function serializeArticleFrontmatter(data, body) {
  const lines = [];
  for (const key of ARTICLE_META_FIELD_ORDER) {
    const v = data[key];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${key}: ${JSON.stringify(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n\n${body.replace(/^\n+/, '')}\n`;
}

function formatArticleDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/* ------------------------------------------------------------
   Generalized "which content object/region is being edited" --
   lets inline text-edit and block add/move/delete work the same
   way whether App.current is a page (hero/main regions) or an
   article (a single body region), without branching everywhere.
   ------------------------------------------------------------ */
function getCurrentEditable() {
  if (!App.current) return null;
  if (App.current.type === 'page') return App.pages[App.current.slug];
  if (App.current.type === 'article') return App.articles[App.current.slug];
  return null;
}
function regionTextareaId(region) {
  if (region === 'hero') return 'b-hero';
  if (region === 'main') return 'b-main';
  if (region === 'body') return 'a-body';
  return null;
}
function getRegionHtml(region) {
  const obj = getCurrentEditable();
  return obj ? obj[region] : null;
}
// Updates the in-memory draft AND mirrors it into the raw-HTML textarea --
// for edits that originate somewhere other than that textarea itself
// (inline preview edits, block add/move/delete). The textarea's own input
// handler updates the draft directly (see syncBodyDraftAndPreview) without
// writing back into itself, so typing doesn't fight its own cursor.
function setRegionHtml(region, html) {
  const obj = getCurrentEditable();
  if (!obj) return;
  obj[region] = html;
  const ta = document.getElementById(regionTextareaId(region));
  if (ta) ta.value = html;
}
function setRegionData(region, html) {
  const obj = getCurrentEditable();
  if (obj) obj[region] = html;
}

/* ------------------------------------------------------------
   Block-level structure ops (Elementor-style add/reorder/remove)
   -- operate on the top-level elements of a region's raw HTML
   string. Always re-derived fresh from the canonical stored
   string (never from the iframe's live, toolbar-decorated DOM),
   so indices can't drift from what's actually saved.
   ------------------------------------------------------------ */
function getBlocks(region) {
  const html = getRegionHtml(region) || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.body.children);
}
function setBlocksHtml(region, elements) {
  setRegionHtml(region, elements.map(el => el.outerHTML).join('\n\n'));
}
function deleteBlock(region, index) {
  const blocks = getBlocks(region);
  if (index < 0 || index >= blocks.length) return;
  blocks.splice(index, 1);
  setBlocksHtml(region, blocks);
}
function moveBlock(region, index, dir) {
  const blocks = getBlocks(region);
  const j = dir === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= blocks.length || j < 0 || j >= blocks.length) return;
  [blocks[index], blocks[j]] = [blocks[j], blocks[index]];
  setBlocksHtml(region, blocks);
}
function insertBlockAt(region, index, html) {
  const blocks = getBlocks(region);
  const tmpDoc = new DOMParser().parseFromString(html, 'text/html');
  const newEls = Array.from(tmpDoc.body.children);
  const pos = (index == null || index > blocks.length) ? blocks.length : Math.max(0, index);
  blocks.splice(pos, 0, ...newEls);
  setBlocksHtml(region, blocks);
}

/* ------------------------------------------------------------
   Click-to-edit-text in the live preview.

   Only text is editable this way (headings, paragraphs, button/link
   labels) -- adding, removing, or reordering elements still goes
   through "+ Insert section" or the raw HTML boxes. Anything inside
   a <form> is left alone entirely so the contact form can't be
   mangled by an accidental click.

   The same "which elements count as an editable leaf" logic runs in
   two places: inside the preview iframe (to decide what to make
   contentEditable) and here in the parent (to find, by position, the
   matching node in the real hero/main HTML string when an edit comes
   back). They have to agree exactly, so this is written once and the
   iframe copy is generated from this same function's source further
   down -- never duplicated by hand.
   ------------------------------------------------------------ */
const INLINE_PASSENGER_TAGS = new Set(['EM', 'I', 'STRONG', 'B', 'SPAN', 'BR', 'SVG', 'PATH', 'RECT', 'CIRCLE', 'POLYGON', 'LINE', 'G']);
const SKIP_CONTAINER_TAGS = new Set(['FORM', 'SCRIPT', 'STYLE', 'CANVAS', 'SELECT', 'TEXTAREA', 'OPTION']);
// Classes handled by the dedicated illustration-upload field (see
// getIllustrationPanels below) rather than plain text editing: the hero
// "quote panel" placeholder, and method.html's identical in-body
// ".section-split-img" placeholders. Both share the same placeholder
// markup/behavior, just in different regions of the page.
const ILLUSTRATION_PANEL_CLASSES = ['hero-quote-panel', 'section-split-img'];

function isPhrasingOnly(el) {
  for (const child of el.children) {
    // tagName is lowercase for SVG-namespace elements (svg/path/rect/...)
    // even inside an HTML document, so normalize before checking the set --
    // otherwise every icon-plus-text pattern (e.g. a button with an inline
    // arrow SVG) falls through to the "not phrasing-only" branch and its
    // visible text silently becomes unreachable by this walk.
    if (!INLINE_PASSENGER_TAGS.has(child.tagName.toUpperCase())) return false;
    if (!isPhrasingOnly(child)) return false;
  }
  return true;
}
function hasEditableText(el) {
  return el.textContent.trim().length > 0;
}
function collectEditableLeaves(root, out) {
  out = out || [];
  if (!root) return out;
  for (const el of root.children) {
    if (SKIP_CONTAINER_TAGS.has(el.tagName.toUpperCase())) continue;
    // Inline SVG diagrams (charts, wave graphics) are decoration, not
    // content -- skip the whole subtree rather than recursing into it.
    // Without this, an SVG <text> label (its tagName isn't in
    // INLINE_PASSENGER_TAGS, so a containing <svg> isn't phrasing-only and
    // gets recursed into) surfaces as its own "editable" leaf, and for an
    // SVG element `.className` is an SVGAnimatedString with no .includes()
    // -- guessLeafKind would throw on it, which was breaking the ENTIRE
    // body tab render for any page with inline SVG charts (e.g. index.md's
    // PMF-wave and doughnut charts) the moment that leaf got labeled.
    if (typeof SVGElement !== 'undefined' && el instanceof SVGElement) continue;
    // cms-generated content (e.g. the articles grid spliced into the
    // articles page at preview/build time) has no corresponding element in
    // the canonical stored HTML -- it's just a marker comment there. Editing
    // it in the preview would compute a leaf index that doesn't line up
    // with anything in the raw string, silently corrupting an unrelated
    // edit. Skip it entirely, both here and in the block-control wiring.
    if (el.classList && el.classList.contains('cms-generated')) continue;
    // Illustration panels (the hero "quote panel", and method.html's
    // in-body ".section-split-img" placeholders -- see renderIllustrationField)
    // are addressed by their own dedicated scheme, not a leaf index -- and
    // their "leaf-ness" would otherwise flip depending on state (an <img>
    // has no textContent, so hasEditableText would drop it the moment an
    // image is uploaded, silently shifting every later leaf's index). Skip
    // them unconditionally, in both states, so they never participate in
    // this count at all. (Inlined literally, not via a shared helper --
    // this function's source is toString()'d into the preview iframe, which
    // can't see any function/const defined outside this template literal.)
    if (el.classList && (el.classList.contains('hero-quote-panel') || el.classList.contains('section-split-img'))) continue;
    // A chart-stat-row's own inner "label + big number" row is a flex div
    // whose only children are <span>s (an INLINE_PASSENGER_TAGS entry), so
    // without this it reads as one "phrasing-only" leaf below and both
    // spans get flattened into a single garbled editable box (the number's
    // own font-size/color inline styles collide visually with the label's).
    // Skip the whole row -- it gets its own Description/Value field pair
    // instead (see renderChartStatRowField), addressed by row position, not
    // a leaf index.
    if (el.classList && el.classList.contains('chart-stat-row')) continue;
    if (isPhrasingOnly(el) && hasEditableText(el)) {
      out.push(el);
    } else {
      collectEditableLeaves(el, out);
    }
  }
  return out;
}

// Same "is this element itself a leaf, or do I need to look inside it"
// check collectEditableLeaves applies to each child of its root -- exposed
// separately so the sidebar's block-card view can ask it of one specific
// block and get exactly the slice of the flat leaf list that block
// contributes, in the same order applyInlineEdit's indices assume.
function leavesForBlock(block) {
  if (SKIP_CONTAINER_TAGS.has(block.tagName.toUpperCase())) return [];
  if (typeof SVGElement !== 'undefined' && block instanceof SVGElement) return [];
  if (block.classList && block.classList.contains('cms-generated')) return [];
  if (block.classList && (block.classList.contains('hero-quote-panel') || block.classList.contains('section-split-img'))) return [];
  if (block.classList && block.classList.contains('chart-stat-row')) return [];
  if (isPhrasingOnly(block) && hasEditableText(block)) return [block];
  return collectEditableLeaves(block);
}

// Best-effort, cosmetic-only labels so the sidebar reads as "Heading" /
// "Paragraph" / "Card grid" instead of a class name or a bare tag -- these
// never affect what gets saved, only how the block list is captioned.
// getAttribute('class') (not .className) because .className on an SVG
// element is an SVGAnimatedString, not a plain string -- no .includes().
function guessBlockLabel(el) {
  const cls = el.getAttribute('class') || '';
  const tag = el.tagName.toLowerCase();
  if (cls.includes('hero-section')) return 'Hero section';
  if (cls.includes('cta-section')) return 'Closing CTA';
  if (cls.includes('card-grid')) return 'Card grid';
  if (cls.includes('stats-section')) return 'Stats row';
  if (cls.includes('trust-bar')) return 'Trust bar';
  if (cls.includes('faq-list')) return 'FAQ list';
  if (cls.includes('hero-ctas')) return 'Button row';
  if (cls.includes('callout-box')) return 'Callout box';
  if (cls.includes('pull-quote-block')) return 'Pull quote';
  if (cls.includes('testimonial-card')) return 'Testimonial';
  if (cls.includes('service-card')) return 'Service card';
  if (cls.includes('case-study-card')) return 'Case study card';
  if (cls.includes('mistakes-grid')) return 'Mistakes grid';
  if (tag === 'h1' || tag === 'h2') return 'Heading';
  if (tag === 'h3') return 'Subheading';
  if (tag === 'p') return 'Paragraph';
  if (tag === 'blockquote') return 'Quote';
  if (tag === 'figure' || tag === 'img' || (tag === 'div' && el.querySelector('img'))) return 'Image';
  return 'Section';
}
function guessLeafKind(el) {
  // Exact class-token match (not a substring check) -- "stat-num" must not
  // also match "case-stat-num" (the Case Study Card's own, unrelated field).
  const cls = (el.getAttribute('class') || '').split(/\s+/);
  const tag = el.tagName.toLowerCase();
  if (tag === 'h1' || tag === 'h2') return 'Heading';
  if (tag === 'h3') return 'Subheading';
  if (tag === 'a') return 'Link text';
  if (tag === 'blockquote') return 'Quote';
  if (tag === 'figcaption') return 'Caption';
  if (cls.includes('section-tag')) return 'Label';
  if (cls.includes('stat-num')) return 'Heading';
  if (cls.includes('stat-label')) return 'Subheading';
  // The Callout Box component's text is a plain <p> with no class of its
  // own (see COMPONENTS['callout-box'].render) -- only its parent carries
  // the ".callout-box" class -- so this has to check up one level.
  if (tag === 'p' && el.parentElement && el.parentElement.classList.contains('callout-box')) return 'Callout';
  return 'Text';
}

// Applies an edit reported by the preview iframe back into the real,
// canonical hero/main HTML string for the current page (and mirrors it
// into the raw-HTML textarea if that tab happens to be open). Nothing is
// committed to GitHub here -- same as typing in the raw box, it's just an
// in-memory draft until Save.
// Re-parses the region fresh, hands the leaf at `index` to `mutate` (which
// can change attributes/classes, not just innerHTML -- needed for the
// illustration field to flip is-placeholder/has-image), then re-serializes.
// Always starting from the canonical stored string (never a cached DOM)
// keeps this safe to call repeatedly without indices drifting.
function transformLeaf(region, index, mutate) {
  const raw = getRegionHtml(region);
  if (raw == null) return false;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const leaves = collectEditableLeaves(doc.body);
  const el = leaves[index];
  if (!el) return false;
  mutate(el);
  setRegionHtml(region, doc.body.innerHTML.trim());
  return true;
}
function applyInlineEdit(region, index, newInnerHtml) {
  return transformLeaf(region, index, el => { el.innerHTML = newInnerHtml; });
}

// Delete/move act immediately (aside from the confirm on delete); insert
// hands off to the same "+ Insert section" modal the sidebar button opens,
// just with a specific target index instead of "append at the end".
function handleBlockMessage(msg) {
  if (!App.current) return;
  const { action, region, index } = msg;
  if (action === 'delete') {
    if (!confirm('Remove this block? Unsaved until you hit Save, but there is no undo once you do.')) return;
    deleteBlock(region, index);
    setStatus('edited (unsaved)', '');
    refreshRegionUI(region);
    refreshPreview();
  } else if (action === 'move') {
    moveBlock(region, index, msg.dir);
    setStatus('edited (unsaved)', '');
    refreshRegionUI(region);
    refreshPreview();
  } else if (action === 'insert') {
    openInsertSectionModal(region, index);
  }
}

window.addEventListener('message', e => {
  if (!e.data || e.data.source !== 'blacfox-cms-preview') return;
  if (e.data.type === 'edit') {
    if (applyInlineEdit(e.data.region, e.data.index, e.data.html)) {
      setStatus('edited (unsaved)', '');
      syncContentFieldBox(e.data.region, e.data.index, e.data.html);
    }
  } else if (e.data.type === 'block') {
    handleBlockMessage(e.data);
  }
});

// Builds the <script> block injected into the preview iframe. Ships the
// exact same collectEditableLeaves/isPhrasingOnly/hasEditableText functions
// defined above (via toString()) so the two sides can never drift apart.
function buildPreviewEditScript(editable) {
  return `<script>
(function() {
  // Never let a link inside the preview actually navigate -- there's
  // nothing at these relative paths inside a srcdoc iframe anyway.
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (a) e.preventDefault();
  }, true);

  ${editable ? `
  var INLINE_PASSENGER_TAGS = new Set(${JSON.stringify([...INLINE_PASSENGER_TAGS])});
  var SKIP_CONTAINER_TAGS = new Set(${JSON.stringify([...SKIP_CONTAINER_TAGS])});
  ${isPhrasingOnly.toString()}
  ${hasEditableText.toString()}
  ${collectEditableLeaves.toString()}

  var toolbar = document.createElement('div');
  toolbar.id = 'cms-toolbar';
  toolbar.innerHTML = '<button data-cmd="strong" onmousedown="return false">B</button>' +
    '<button data-cmd="em" onmousedown="return false" style="font-style:italic">Highlight</button>' +
    '<button data-cmd="clear" onmousedown="return false">Clear</button>';
  document.body.appendChild(toolbar);
  var style = document.createElement('style');
  style.textContent = '.cms-editable{outline:1px dashed transparent;cursor:text;transition:outline-color .1s}' +
    '.cms-editable:hover{outline-color:rgba(233,92,37,.5)}' +
    '.cms-editable.cms-active{outline:2px solid #e95c25;outline-offset:1px}' +
    '#cms-toolbar{position:fixed;z-index:99999;display:none;background:#1a1a1a;border:1px solid rgba(255,255,255,.15);border-radius:7px;padding:4px;gap:2px;box-shadow:0 6px 20px rgba(0,0,0,.4)}' +
    '#cms-toolbar button{background:none;border:none;color:#eee;font-size:11px;font-weight:700;padding:5px 9px;border-radius:5px;cursor:pointer;font-family:inherit}' +
    '#cms-toolbar button:hover{background:rgba(255,255,255,.12)}' +
    '.cms-block{outline:2px dashed transparent;outline-offset:3px;transition:outline-color .1s}' +
    '.cms-block:hover{outline-color:rgba(80,140,255,.6)}' +
    '#cms-block-toolbar{position:fixed;z-index:99999;display:none;background:#1a1a1a;border:1px solid rgba(255,255,255,.15);border-radius:7px;padding:4px;gap:2px;box-shadow:0 6px 20px rgba(0,0,0,.4)}' +
    '#cms-block-toolbar button{background:none;border:none;color:#eee;font-size:12px;font-weight:700;padding:5px 8px;border-radius:5px;cursor:pointer;font-family:inherit}' +
    '#cms-block-toolbar button:hover{background:rgba(255,255,255,.12)}' +
    '#cms-block-toolbar button:disabled{opacity:.3;cursor:default}' +
    '#cms-block-toolbar button:disabled:hover{background:none}' +
    '.cms-block-gap{height:16px;margin:-8px 0;position:relative;z-index:9997;display:flex;align-items:center;justify-content:center}' +
    '.cms-block-gap button{opacity:0;width:22px;height:22px;border-radius:50%;background:#e95c25;color:#fff;border:none;cursor:pointer;font-size:15px;line-height:1;font-family:inherit;transition:opacity .12s;box-shadow:0 2px 8px rgba(0,0,0,.35)}' +
    '.cms-block-gap:hover button{opacity:1}';
  document.head.appendChild(style);

  function toggleWrap(tagName) {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var anc = range.commonAncestorContainer;
    if (anc.nodeType === 3) anc = anc.parentElement;
    var existing = anc.closest(tagName);
    if (existing) {
      var parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
    } else {
      var wrapper = document.createElement(tagName);
      try { range.surroundContents(wrapper); }
      catch (err) { var frag = range.extractContents(); wrapper.appendChild(frag); range.insertNode(wrapper); }
    }
    var editableEl = anc.closest ? anc.closest('.cms-editable') : null;
    if (editableEl) editableEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function clearFormatting() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var text = range.toString();
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    var node = sel.anchorNode;
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    var editableEl = el && el.closest ? el.closest('.cms-editable') : null;
    if (editableEl) editableEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  toolbar.addEventListener('mousedown', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    e.preventDefault();
    var cmd = btn.dataset.cmd;
    if (cmd === 'clear') clearFormatting(); else toggleWrap(cmd);
  });
  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { toolbar.style.display = 'none'; return; }
    var anc = sel.anchorNode;
    var el = anc && anc.nodeType === 3 ? anc.parentElement : anc;
    if (!el || !el.closest || !el.closest('.cms-editable.cms-active')) { toolbar.style.display = 'none'; return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    toolbar.style.display = 'flex';
    toolbar.style.left = Math.max(4, rect.left) + 'px';
    toolbar.style.top = Math.max(4, rect.top - 40) + 'px';
  });

  function wireRegion(rootSelector, region) {
    var root = document.querySelector(rootSelector);
    if (!root) return;
    var leaves = collectEditableLeaves(root);
    leaves.forEach(function(el, index) {
      el.classList.add('cms-editable');
      el.title = 'Click to edit';
      var sendTimer = null;
      function send() {
        parent.postMessage({ source: 'blacfox-cms-preview', type: 'edit', region: region, index: index, html: el.innerHTML }, '*');
      }
      el.addEventListener('click', function(e) {
        if (el.contentEditable === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.cms-active').forEach(function(x) { x.contentEditable = 'false'; x.classList.remove('cms-active'); });
        el.contentEditable = 'true';
        el.classList.add('cms-active');
        el.focus();
      });
      el.addEventListener('input', function() {
        clearTimeout(sendTimer);
        sendTimer = setTimeout(send, 500);
      });
      el.addEventListener('blur', function() {
        clearTimeout(sendTimer);
        el.contentEditable = 'false';
        el.classList.remove('cms-active');
        toolbar.style.display = 'none';
        send();
      });
    });
  }

  // Elementor-style block controls: every TOP-LEVEL element of a region
  // (one whole "+ Insert section" component, or a hand-written section) can
  // be reordered or deleted via a floating toolbar, and new ones can be
  // dropped in between via the "+" gap buttons. Text *inside* a block is
  // still handled by wireRegion above -- the two layers don't conflict
  // because block controls never touch a block's own innerHTML, only its
  // position among siblings (so a leaf-edit's later el.innerHTML send
  // can't ever pick up toolbar/gap markup).
  var blockToolbar = document.createElement('div');
  blockToolbar.id = 'cms-block-toolbar';
  blockToolbar.innerHTML = '<button data-act="up" title="Move up">↑</button><button data-act="down" title="Move down">↓</button><button data-act="del" title="Remove">\u{1F5D1}</button>';
  document.body.appendChild(blockToolbar);
  var blockHideTimer = null;
  var activeBlock = null;
  function showBlockToolbar(el) {
    clearTimeout(blockHideTimer);
    activeBlock = el;
    var r = el.getBoundingClientRect();
    blockToolbar.style.display = 'flex';
    blockToolbar.style.top = Math.max(4, r.top - 34) + 'px';
    blockToolbar.style.left = Math.max(4, r.right - 96) + 'px';
    var buttons = blockToolbar.querySelectorAll('button');
    var idx = parseInt(el.dataset.cmsIndex, 10);
    var count = parseInt(el.dataset.cmsCount, 10);
    buttons[0].disabled = idx <= 0;
    buttons[1].disabled = idx >= count - 1;
  }
  function scheduleHideBlockToolbar() {
    clearTimeout(blockHideTimer);
    blockHideTimer = setTimeout(function() { blockToolbar.style.display = 'none'; activeBlock = null; }, 250);
  }
  blockToolbar.addEventListener('mouseenter', function() { clearTimeout(blockHideTimer); });
  blockToolbar.addEventListener('mouseleave', scheduleHideBlockToolbar);
  blockToolbar.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn || btn.disabled || !activeBlock) return;
    var region = activeBlock.dataset.cmsRegion;
    var index = parseInt(activeBlock.dataset.cmsIndex, 10);
    var act = btn.dataset.act;
    if (act === 'del') parent.postMessage({ source: 'blacfox-cms-preview', type: 'block', action: 'delete', region: region, index: index }, '*');
    else parent.postMessage({ source: 'blacfox-cms-preview', type: 'block', action: 'move', region: region, index: index, dir: act }, '*');
  });

  function wireBlocks(rootSelector, region) {
    var root = document.querySelector(rootSelector);
    if (!root) return;
    // cms-generated content (the articles grid) is atomic from the CMS's
    // point of view -- see the matching skip in collectEditableLeaves.
    var blocks = Array.from(root.children).filter(function(el) { return !el.classList.contains('cms-generated'); });
    function makeGap(index) {
      var g = document.createElement('div');
      g.className = 'cms-block-gap';
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = '+';
      b.title = 'Insert here';
      b.addEventListener('click', function(e) {
        e.stopPropagation();
        parent.postMessage({ source: 'blacfox-cms-preview', type: 'block', action: 'insert', region: region, index: index }, '*');
      });
      g.appendChild(b);
      return g;
    }
    root.insertBefore(makeGap(0), root.firstChild);
    blocks.forEach(function(el, i) {
      el.classList.add('cms-block');
      el.dataset.cmsRegion = region;
      el.dataset.cmsIndex = i;
      el.dataset.cmsCount = blocks.length;
      el.addEventListener('mouseenter', function() { showBlockToolbar(el); });
      el.addEventListener('mouseleave', scheduleHideBlockToolbar);
      var gap = makeGap(i + 1);
      if (el.nextSibling) el.parentNode.insertBefore(gap, el.nextSibling);
      else el.parentNode.appendChild(gap);
    });
  }

  wireRegion('#cms-hero-root', 'hero');
  wireRegion('#page-content, .other-page-content', 'main');
  wireBlocks('#page-content, .other-page-content', 'main');
  wireRegion('#cms-article-body-root', 'body');
  wireBlocks('#cms-article-body-root', 'body');
  ` : ''}
})();
<\/script>`;
}

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
    // The four sections below (pages, articles, nav, footer) are independent
    // reads -- running them one after another (the original approach) meant
    // every additional page/article added its own fully-serial round trip
    // before the sidebar could even render. Promise.all lets them overlap.
    const [pages, articles, navFile, footerFile] = await Promise.all([
      (async () => {
        const dir = await gh.getFile(gh.owner, gh.repo, 'pages', App.branch);
        const files = (dir && dir.dir ? dir.dir : []).filter(f => f.name.endsWith('.md'));
        const pages = {};
        await Promise.all(files.map(async f => {
          const file = await gh.getFile(gh.owner, gh.repo, f.path, App.branch);
          const { data, body } = parseFrontmatter(file.text);
          const { hero, main } = splitBody(body);
          const slug = f.name.replace(/\.md$/, '');
          pages[slug] = { path: f.path, sha: file.sha, data, hero, main };
        }));
        return pages;
      })(),
      (async () => {
        const artDir = await gh.getFile(gh.owner, gh.repo, 'content/articles', App.branch);
        const artFiles = (artDir && artDir.dir ? artDir.dir : []).filter(f => f.name.endsWith('.md'));
        const articles = {};
        await Promise.all(artFiles.map(async f => {
          const file = await gh.getFile(gh.owner, gh.repo, f.path, App.branch);
          const { data, body } = parseFrontmatter(file.text);
          const slug = f.name.replace(/\.md$/, '');
          articles[slug] = { path: f.path, sha: file.sha, data, body: body.trim() };
        }));
        return articles;
      })(),
      gh.getFile(gh.owner, gh.repo, 'partials/nav.html', App.branch),
      gh.getFile(gh.owner, gh.repo, 'partials/footer.html', App.branch),
    ]);
    App.pages = pages;
    App.articles = articles;
    App.navDoc = { sha: navFile.sha, doc: new DOMParser().parseFromString(navFile.text, 'text/html') };
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
      ${slug !== 'index' ? `<button class="icon-btn tree-del-btn" data-del-page="${slug}" title="Delete page">✕</button>` : ''}
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
  tree.querySelectorAll('[data-del-page]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deletePage(btn.dataset.delPage); });
  });

  const artTree = document.getElementById('article-tree');
  const artSlugs = Object.keys(App.articles).sort((a, b) => (App.articles[b].data.date || '').localeCompare(App.articles[a].data.date || ''));
  artTree.innerHTML = artSlugs.length ? artSlugs.map(slug => {
    const a = App.articles[slug];
    const active = App.current && App.current.type === 'article' && App.current.slug === slug;
    return `<div class="tree-item${active ? ' active' : ''}" data-art-slug="${slug}">
      <span class="tree-item-label">${escHtml(a.data.title || slug)}</span>
      <button class="icon-btn tree-del-btn" data-del-article="${slug}" title="Delete article">✕</button>
    </div>`;
  }).join('') : '<p class="field-hint" style="margin:2px 6px">No articles yet.</p>';
  artTree.querySelectorAll('.tree-item').forEach(el => {
    el.addEventListener('click', () => {
      App.current = { type: 'article', slug: el.dataset.artSlug };
      App.activeTab = 'meta';
      renderEditor();
      refreshPreview();
    });
  });
  artTree.querySelectorAll('[data-del-article]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteArticle(btn.dataset.delArticle); });
  });

  ['nav', 'footer'].forEach(kind => {
    const el = document.getElementById(kind + '-tree-item');
    el.classList.toggle('active', App.current && App.current.type === kind);
  });
}
document.getElementById('nav-tree-item').addEventListener('click', () => { App.current = { type: 'nav' }; renderEditor(); refreshPreview(); });
document.getElementById('footer-tree-item').addEventListener('click', () => { App.current = { type: 'footer' }; renderEditor(); refreshPreview(); });

document.getElementById('add-article-btn').addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  openModal(`
    <div class="modal-title">Add an article</div>
    <div class="field-group"><label class="field-label">Title</label><input class="field-input" id="na-title" placeholder="How we helped Acme Co. grow pipeline"></div>
    <div class="field-group"><label class="field-label">Slug (used in the URL)</label><input class="field-input" id="na-slug" placeholder="auto-generated from title"></div>
    <div class="field-group"><label class="field-label">Author</label><input class="field-input" id="na-author" placeholder="Your name"></div>
    <p class="field-hint">Creates content/articles/&lt;slug&gt;.md. Add the banner image and write the body after creating it.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="na-confirm">Create article</button></div>
  `);
  const titleInput = document.getElementById('na-title');
  const slugInput = document.getElementById('na-slug');
  let slugTouched = false;
  slugInput.addEventListener('input', () => { slugTouched = true; });
  titleInput.addEventListener('input', () => {
    if (slugTouched) return;
    slugInput.value = titleInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  });
  document.getElementById('na-confirm').addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const slug = slugInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const author = document.getElementById('na-author').value.trim();
    if (!title || !slug) { toast('Title and slug are required.', 'error'); return; }
    if (App.articles[slug]) { toast('An article with that slug already exists.', 'error'); return; }
    closeModal();
    setStatus('creating article…', 'busy');
    try {
      const data = {
        title, description: '', author, date: today, banner: '',
        cssFiles: ['assets/css/site.css', 'assets/css/articles.css'],
        bodyClass: 'theme-hero-dark', canonical: `https://blacfox.com/article-${slug}.html`, pageScripts: [],
      };
      const body = '<p>Start writing here, or use "+ Insert block" to add headings, images, and more.</p>';
      const content = serializeArticleFrontmatter(data, body);
      const res = await gh.putFile(gh.owner, gh.repo, `content/articles/${slug}.md`, b64EncodeText(content), `Add ${slug} article via Blacfox CMS`, App.branch);
      App.articles[slug] = { path: `content/articles/${slug}.md`, sha: res.content.sha, data, body };
      renderSidebar();
      App.current = { type: 'article', slug };
      App.activeTab = 'meta';
      renderEditor();
      refreshPreview();
      setStatus('created', 'ok');
      toast(`Article "${slug}" created.`, 'success');
    } catch (e) {
      setStatus('error', 'error');
      toast('Could not create article: ' + e.message, 'error');
    }
  });
});

async function deletePage(slug) {
  if (slug === 'index') { toast('The home page can’t be deleted.', 'error'); return; }
  if (!confirm(`Delete page "${slug}"? This removes pages/${slug}.md and its nav link from ${App.branch}.`)) return;
  setStatus('deleting…', 'busy');
  try {
    const p = App.pages[slug];
    await gh.deleteFile(gh.owner, gh.repo, p.path, `Delete ${slug} page via Blacfox CMS`, App.branch, p.sha);
    delete App.pages[slug];
    const navEl = App.navDoc.doc.querySelector('.nav-links-list');
    const link = Array.from(navEl.querySelectorAll('a')).find(a => a.getAttribute('href') === `${slug}.html`);
    if (link) { link.remove(); await saveNav(`Remove ${slug} from nav via Blacfox CMS`); }
    if (App.current && App.current.type === 'page' && App.current.slug === slug) App.current = null;
    renderSidebar();
    renderEditor();
    refreshPreview();
    setStatus('deleted', 'ok');
    toast(`Page "${slug}" deleted.`, 'success');
  } catch (e) {
    setStatus('error', 'error');
    toast('Delete failed: ' + e.message, 'error');
  }
}

async function deleteArticle(slug) {
  if (!confirm(`Delete article "${slug}"? This removes content/articles/${slug}.md from ${App.branch}.`)) return;
  setStatus('deleting…', 'busy');
  try {
    const a = App.articles[slug];
    await gh.deleteFile(gh.owner, gh.repo, a.path, `Delete ${slug} article via Blacfox CMS`, App.branch, a.sha);
    delete App.articles[slug];
    if (App.current && App.current.type === 'article' && App.current.slug === slug) App.current = null;
    renderSidebar();
    renderEditor();
    refreshPreview();
    setStatus('deleted', 'ok');
    toast(`Article "${slug}" deleted.`, 'success');
  } catch (e) {
    setStatus('error', 'error');
    toast('Delete failed: ' + e.message, 'error');
  }
}

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
      const navList = App.navDoc.doc.querySelector('.nav-links-list');
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
  } else if (App.current.type === 'article') {
    tabsEl.innerHTML = `<div class="editor-tab${App.activeTab === 'meta' ? ' active' : ''}" data-tab="meta">Details</div><div class="editor-tab${App.activeTab === 'body' ? ' active' : ''}" data-tab="body">Body</div>`;
    tabsEl.querySelectorAll('.editor-tab').forEach(t => t.addEventListener('click', () => { App.activeTab = t.dataset.tab; renderEditor(); }));
    scroll.innerHTML = App.activeTab === 'meta' ? renderArticleDetailsTab() : renderArticleBodyTab();
    wireArticleTabHandlers();
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
      App.pages[App.current.slug].data.layout = b.dataset.layout;
      refreshPreview();
    }));
    document.getElementById('m-bodyclass').addEventListener('input', e => {
      App.pages[App.current.slug].data.bodyClass = e.target.value;
      refreshPreview();
    });
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
    document.getElementById('insert-section-btn').addEventListener('click', () => openInsertSectionModal('main', null));
    document.getElementById('b-hero').addEventListener('input', syncBodyDraftAndPreview);
    document.getElementById('b-main').addEventListener('input', syncBodyDraftAndPreview);
    wireEditableBoxes(document.getElementById('content-blocks-hero'));
    wireContentBlocksUI('main');
  }
}

// The preview renders whatever's in the current draft (page hero/main, or
// an article's body) -- so typing into a raw-HTML box has to update that
// in-memory draft immediately (not just on Save) for the preview to feel
// live. Nothing is committed to GitHub until "Save" is clicked; this only
// updates the browser's own copy. Uses setRegionData (not setRegionHtml) so
// it doesn't write back into the very textarea the user is typing in.
function syncBodyDraftAndPreview() {
  if (!App.current) return;
  if (App.current.type === 'page') {
    setRegionData('hero', document.getElementById('b-hero').value);
    setRegionData('main', document.getElementById('b-main').value);
  } else if (App.current.type === 'article') {
    setRegionData('body', document.getElementById('a-body').value);
  }
  refreshPreview();
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
/* ------------------------------------------------------------
   Plain-text content editing for the sidebar -- the whole point is that a
   non-technical editor should never see a raw tag. A region's text leaves
   (same leaves collectEditableLeaves finds in the preview, same order, same
   indices applyInlineEdit expects) render as labeled contenteditable boxes:
   the actual styled text (an <em> shows as real italic orange text, not as
   "<em>"), never HTML source. 'hero' gets a flat list of fields (there's
   only ever one hero, nothing to reorder); 'main'/'body' get that same
   list grouped into move/delete-able section cards, matching the same
   block model the live preview's floating toolbar drives.

   The raw HTML textareas (#b-hero/#b-main/#a-body) still exist underneath
   an "Advanced" disclosure for anyone who needs to hand-edit markup --
   applyInlineEdit/setRegionHtml already mirror every change into them, so
   Save (which reads directly from those textareas) keeps working exactly
   as before regardless of which view was used to make the edit.
   ------------------------------------------------------------ */
// The hand-authored illustration placeholder (`<div class="hero-quote-panel
// is-placeholder"><svg>...</svg><span>Illustration placeholder</span></div>`,
// identical across all 9 pages' heroes -- see site.css's "stands in for a
// future custom illustration" comment -- plus the same placeholder markup
// reused in-body as `.section-split-img` on method.html, 3x) is deliberately
// skipped by collectEditableLeaves/leavesForBlock above (a text-edit box
// would let someone "edit" an SVG icon as raw HTML, and once it holds a
// real <img> it wouldn't even qualify as a leaf -- an <img> has no
// textContent -- so its leaf-ness would depend on state, which would shift
// every later leaf's index the moment an image got uploaded). It gets its
// own image-upload field instead, addressed by its position among
// `ILLUSTRATION_PANEL_CLASSES` elements rather than a leaf index, so it's
// stable in both states.
const PLACEHOLDER_ICON_HTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.75"/><path d="M21 15l-5-5L5 21"/></svg>\n      <span>Illustration placeholder</span>';
const ILLUSTRATION_PANEL_SELECTOR = ILLUSTRATION_PANEL_CLASSES.map(c => '.' + c).join(', ');
function transformIllustrationPanel(region, panelIndex, mutate) {
  const raw = getRegionHtml(region);
  if (raw == null) return false;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const panels = Array.from(doc.body.querySelectorAll(ILLUSTRATION_PANEL_SELECTOR));
  const el = panels[panelIndex];
  if (!el) return false;
  mutate(el);
  setRegionHtml(region, doc.body.innerHTML.trim());
  return true;
}
function renderIllustrationField(region, panel, panelIndex, totalPanels) {
  const img = panel.querySelector('img');
  const src = img ? img.getAttribute('src') : '';
  const size = panel.classList.contains('size-sm') ? 'sm' : panel.classList.contains('size-lg') ? 'lg' : 'md';
  const label = totalPanels > 1 ? `Illustration ${panelIndex + 1}` : 'Illustration';
  return `<div class="content-field">
    <label class="content-field-label">${escHtml(label)}</label>
    <div class="img-drop illustration-drop" data-region="${region}" data-panel-index="${panelIndex}" data-src="${escHtml(src)}">
      <div class="img-drop-lbl illustration-drop-lbl">${src ? 'Loading preview…' : 'Click or drop a JPG/PNG to replace this placeholder'}</div>
      <input type="file" class="illustration-file-input" accept="image/*">
    </div>
    ${src ? `
    <div class="radio-row illustration-size-row" data-region="${region}" data-panel-index="${panelIndex}" style="margin-top:8px">
      <div class="radio-btn illustration-size-btn${size === 'sm' ? ' on' : ''}" data-size="sm">Small</div>
      <div class="radio-btn illustration-size-btn${size === 'md' ? ' on' : ''}" data-size="md">Medium</div>
      <div class="radio-btn illustration-size-btn${size === 'lg' ? ' on' : ''}" data-size="lg">Large</div>
    </div>
    <button class="btn btn-ghost btn-sm illustration-remove-btn" data-region="${region}" data-panel-index="${panelIndex}" style="margin-top:6px">Remove image</button>` : ''}
  </div>`;
}

/* ------------------------------------------------------------
   Index.html's hand-built "chart-pair" (S01 The Proof) -- the bar/line
   ratio chart and the doughnut/arc chart are pure inline CSS/SVG, not
   Chart.js, with their animation targets originally hardcoded in
   index.css's @keyframes (see barGrow/benchGrow/arcGrow, now driven by a
   --bar-target/--arc-target custom property instead so a value typed here
   actually redraws the chart). Addressed by DOM position (like the
   illustration panels above), not a leaf index, since editing a value here
   also needs to rewrite a sibling bar's width/dot position or the arc's
   dashoffset/dot coordinates -- structured state a plain text leaf can't
   carry.
   ------------------------------------------------------------ */
// Pulls the leading number out of a ratio string like "10:1" or a percent
// like "70%" -- parseFloat naturally stops at the first non-numeric
// character, so both forms work without a bespoke parser.
function parseRatioValue(text) {
  const n = parseFloat(String(text == null ? '' : text).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// Recomputes every row's bar width (and its endpoint dot's position) as a
// percentage of the largest value among the rows sharing this container --
// i.e. the biggest number always draws a full-width bar, and the rest scale
// relative to it, matching the page's original hand-tuned 100%/30% split
// for 10:1 vs 3:1 (3/10 = 30%). Recalculated from both rows every time
// either one changes, since either edit can shift the relative proportions.
function recalcChartStatBars(container) {
  const rows = Array.from(container.querySelectorAll('.chart-stat-row'));
  const values = rows.map(row => {
    const numEl = row.querySelector('.chart-stat-num');
    return parseRatioValue(numEl ? numEl.textContent : '');
  });
  const maxVal = values.reduce((m, v) => (v != null && v > m ? v : m), 0);
  rows.forEach((row, i) => {
    const v = values[i];
    const pct = (maxVal > 0 && v != null) ? Math.max(0, Math.min(100, (v / maxVal) * 100)) : 0;
    const fill = row.querySelector('.chart-stat-fill');
    const dot = row.querySelector('.chart-stat-dot');
    if (fill) fill.style.setProperty('--bar-target', pct + '%');
    if (dot) dot.style.left = pct + '%';
  });
}
function updateChartStatRow(region, rowIndex, field, value) {
  const raw = getRegionHtml(region);
  if (raw == null) return false;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const rows = Array.from(doc.body.querySelectorAll('.chart-stat-row'));
  const row = rows[rowIndex];
  if (!row) return false;
  const target = row.querySelector(field === 'desc' ? '.chart-stat-desc' : '.chart-stat-num');
  if (target) target.innerHTML = value;
  const container = row.closest('.glass-card') || row.parentElement;
  if (container) recalcChartStatBars(container);
  setRegionHtml(region, doc.body.innerHTML.trim());
  return true;
}
function renderChartStatRowField(region, row, rowIndex) {
  const desc = row.querySelector('.chart-stat-desc');
  const num = row.querySelector('.chart-stat-num');
  return `<div class="content-field-group">
    <div class="content-field">
      <label class="content-field-label">Description</label>
      <div class="content-editable-box chart-stat-field" contenteditable="true" data-region="${region}" data-chart-row-index="${rowIndex}" data-chart-field="desc">${desc ? desc.innerHTML : ''}</div>
    </div>
    <div class="content-field">
      <label class="content-field-label">Value</label>
      <div class="content-editable-box chart-stat-field" contenteditable="true" data-region="${region}" data-chart-row-index="${rowIndex}" data-chart-field="num">${num ? num.innerHTML : ''}</div>
    </div>
  </div>`;
}
// Circle circumference matching the fixed stroke-dasharray already on
// .arc-fill in index.md (2*pi*78 ~= 489.85, rounded to the same 490 the
// page already hardcodes there, so a 100% value draws a fully closed ring).
const CHART_ARC_CIRCUMFERENCE = 490;
const CHART_ARC_RADIUS = 78;
const CHART_ARC_CENTER = 100;
function updateChartArcPanel(region, panelIndex, value) {
  const raw = getRegionHtml(region);
  if (raw == null) return false;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const panels = Array.from(doc.body.querySelectorAll('.chart-arc-panel'));
  const panel = panels[panelIndex];
  if (!panel) return false;
  const pct = Math.max(0, Math.min(100, parseRatioValue(value) || 0));
  const textEl = panel.querySelector('.chart-arc-text');
  if (textEl) textEl.textContent = pct + '%';
  const fillEl = panel.querySelector('.arc-fill');
  if (fillEl) fillEl.style.setProperty('--arc-target', String(Math.round(CHART_ARC_CIRCUMFERENCE * (1 - pct / 100))));
  const dotEl = panel.querySelector('#arcDotEnd');
  if (dotEl) {
    // The arc-fill circle itself starts at 3 o'clock and is rotated -90deg
    // (see index.md) so it visually starts at 12 o'clock; arcDotEnd is a
    // separate, unrotated circle, so its cx/cy must be computed in that
    // same rotated frame directly: -90deg (12 o'clock) plus the swept
    // fraction of a full 360deg turn.
    const angleRad = (-90 + (pct / 100) * 360) * Math.PI / 180;
    dotEl.setAttribute('cx', (CHART_ARC_CENTER + CHART_ARC_RADIUS * Math.cos(angleRad)).toFixed(1));
    dotEl.setAttribute('cy', (CHART_ARC_CENTER + CHART_ARC_RADIUS * Math.sin(angleRad)).toFixed(1));
  }
  setRegionHtml(region, doc.body.innerHTML.trim());
  return true;
}
function renderChartArcField(region, panel, panelIndex) {
  const textEl = panel.querySelector('.chart-arc-text');
  const pct = textEl ? parseRatioValue(textEl.textContent) : null;
  return `<div class="content-field">
    <label class="content-field-label">Percentage</label>
    <div class="content-editable-box chart-arc-field" contenteditable="true" data-region="${region}" data-chart-arc-index="${panelIndex}">${pct != null ? pct : ''}</div>
  </div>`;
}
function renderContentFieldForLeaf(region, leaf, index) {
  return `<div class="content-field">
    <label class="content-field-label">${escHtml(guessLeafKind(leaf))}</label>
    <div class="content-editable-box" contenteditable="true" data-region="${region}" data-leaf-index="${index}">${leaf.innerHTML}</div>
  </div>`;
}
// leavesForBlock flattens a block down to one leaf per editable text node,
// in document order, with no memory of which ones were siblings in the
// source markup -- e.g. a stats row's 4x (number, caption) pairs all come
// back as 8 leaves in a row. That's fine for indexing (applyInlineEdit just
// needs the flat order), but rendering them flat makes the panel read as 8
// unrelated fields instead of the 4 grouped stats the live preview shows.
// This re-groups the panel view only: consecutive leaves that share the
// same immediate parent element (and there's more than one of them, so a
// lone paragraph directly under the block isn't boxed for no reason) get
// wrapped in one bordered .content-field-group, mirroring how the parent
// markup (e.g. .stat-item) groups them visually on the page.
function groupLeafFieldsHTML(region, leaves, nextIndex) {
  const out = [];
  let i = 0;
  while (i < leaves.length) {
    const parent = leaves[i].parentElement;
    let j = i + 1;
    while (j < leaves.length && leaves[j].parentElement === parent) j++;
    const group = leaves.slice(i, j).map(leaf => renderContentFieldForLeaf(region, leaf, nextIndex())).join('');
    out.push(j - i > 1 ? `<div class="content-field-group">${group}</div>` : group);
    i = j;
  }
  return out.join('');
}
// Shared by renderLeafFieldsHTML (hero -- flat) and renderContentBlocksHTML
// (main/body -- grouped per block) so both regions get illustration/chart
// fields wherever those panels actually live, not just wherever the feature
// happened to be wired in first. Returns them still tagged with their
// GLOBAL region-wide index (matching what a fresh, independent re-parse via
// updateChartStatRow/updateChartArcPanel/transformIllustrationPanel would
// enumerate), since that's what those transform functions address by -- a
// per-block-local index would silently target the wrong panel the moment a
// page has more than one block containing one.
function renderNonLeafFieldsHTML(doc) {
  const panels = Array.from(doc.body.querySelectorAll(ILLUSTRATION_PANEL_SELECTOR));
  const chartRows = Array.from(doc.body.querySelectorAll('.chart-stat-row'));
  const chartArcs = Array.from(doc.body.querySelectorAll('.chart-arc-panel'));
  return { panels, chartRows, chartArcs };
}
function renderLeafFieldsHTML(region) {
  const html = getRegionHtml(region) || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const leaves = collectEditableLeaves(doc.body);
  const textFields = leaves.map((leaf, i) => renderContentFieldForLeaf(region, leaf, i)).join('');
  const { panels, chartRows, chartArcs } = renderNonLeafFieldsHTML(doc);
  const illustrationFields = panels.map((panel, i) => renderIllustrationField(region, panel, i, panels.length)).join('');
  const chartStatFields = chartRows.map((row, i) => renderChartStatRowField(region, row, i)).join('');
  const chartArcFields = chartArcs.map((panel, i) => renderChartArcField(region, panel, i)).join('');
  return (textFields + illustrationFields + chartStatFields + chartArcFields) || '<p class="field-hint">Nothing editable here yet.</p>';
}
function renderContentBlocksHTML(region) {
  const html = getRegionHtml(region) || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = Array.from(doc.body.children);
  if (!blocks.length) return '<p class="field-hint" style="margin:2px 0 10px">Nothing here yet — use the button below to add the first section.</p>';
  const { panels, chartRows, chartArcs } = renderNonLeafFieldsHTML(doc);
  let idx = 0;
  return blocks.map((block, blockIdx) => {
    const textFields = groupLeafFieldsHTML(region, leavesForBlock(block), () => idx++);
    const illustrationFields = panels
      .map((panel, gi) => [panel, gi])
      .filter(([panel]) => block.contains(panel))
      .map(([panel, gi]) => renderIllustrationField(region, panel, gi, panels.length))
      .join('');
    const chartStatFields = chartRows
      .map((row, gi) => [row, gi])
      .filter(([row]) => block.contains(row))
      .map(([row, gi]) => renderChartStatRowField(region, row, gi))
      .join('');
    const chartArcFields = chartArcs
      .map((panel, gi) => [panel, gi])
      .filter(([panel]) => block.contains(panel))
      .map(([panel, gi]) => renderChartArcField(region, panel, gi))
      .join('');
    const fields = textFields + illustrationFields + chartStatFields + chartArcFields;
    return `<div class="chrome-item-card">
      <div class="chrome-item-head">
        <span class="chrome-item-badge">${escHtml(guessBlockLabel(block))}</span>
        <div class="move-btns">
          <button data-block-move="up" data-block-index="${blockIdx}" title="Move up" ${blockIdx === 0 ? 'disabled' : ''}>↑</button>
          <button data-block-move="down" data-block-index="${blockIdx}" title="Move down" ${blockIdx === blocks.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-block-del data-block-index="${blockIdx}" title="Remove section">✕</button>
        </div>
      </div>
      ${fields || '<p class="field-hint">No plain text in this section — use the live preview to change it, or Advanced HTML below.</p>'}
    </div>`;
  }).join('');
}
function wireEditableBoxes(container) {
  if (!container) return;
  // :not(...) here because chart-stat-field/chart-arc-field are also
  // .content-editable-box (for shared styling) but carry no data-leaf-index
  // -- they're wired separately below, addressed by row/panel position.
  container.querySelectorAll('.content-editable-box:not(.chart-stat-field):not(.chart-arc-field)').forEach(box => {
    let sendTimer = null;
    const commit = () => {
      applyInlineEdit(box.dataset.region, parseInt(box.dataset.leafIndex, 10), box.innerHTML);
      refreshPreview();
    };
    box.addEventListener('input', () => { clearTimeout(sendTimer); sendTimer = setTimeout(commit, 400); });
    box.addEventListener('blur', () => { clearTimeout(sendTimer); commit(); });
  });
  wireIllustrationFields(container);
  wireChartFields(container);
}
function wireChartFields(container) {
  container.querySelectorAll('.chart-stat-field').forEach(box => {
    let sendTimer = null;
    const commit = () => {
      updateChartStatRow(box.dataset.region, parseInt(box.dataset.chartRowIndex, 10), box.dataset.chartField, box.innerHTML);
      refreshPreview();
    };
    box.addEventListener('input', () => { clearTimeout(sendTimer); sendTimer = setTimeout(commit, 400); });
    box.addEventListener('blur', () => { clearTimeout(sendTimer); commit(); });
  });
  container.querySelectorAll('.chart-arc-field').forEach(box => {
    let sendTimer = null;
    const commit = () => {
      updateChartArcPanel(box.dataset.region, parseInt(box.dataset.chartArcIndex, 10), box.textContent);
      refreshPreview();
    };
    box.addEventListener('input', () => { clearTimeout(sendTimer); sendTimer = setTimeout(commit, 400); });
    box.addEventListener('blur', () => { clearTimeout(sendTimer); commit(); });
  });
}
function wireIllustrationFields(container) {
  container.querySelectorAll('.illustration-drop').forEach(drop => {
    const region = drop.dataset.region;
    const panelIndex = parseInt(drop.dataset.panelIndex, 10);
    const src = drop.dataset.src;
    if (src) {
      fetchAssetDataUri(src).then(uri => {
        const lbl = drop.querySelector('.illustration-drop-lbl');
        if (!lbl) return; // user navigated away, or the field was re-rendered, before this resolved
        if (uri) {
          drop.insertAdjacentHTML('afterbegin', `<img src="${uri}">`);
          lbl.textContent = src;
        } else {
          lbl.textContent = src + ' (file not found in repo)';
        }
      });
    }
    drop.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') drop.querySelector('.illustration-file-input').click(); });
    drop.querySelector('.illustration-file-input').addEventListener('change', e => onIllustrationFilePicked(e, region, panelIndex, drop));
  });
  container.querySelectorAll('.illustration-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeIllustration(btn.dataset.region, parseInt(btn.dataset.panelIndex, 10)));
  });
  container.querySelectorAll('.illustration-size-row').forEach(row => {
    const region = row.dataset.region;
    const panelIndex = parseInt(row.dataset.panelIndex, 10);
    row.querySelectorAll('.illustration-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        transformIllustrationPanel(region, panelIndex, el => {
          el.classList.remove('size-sm', 'size-md', 'size-lg');
          el.classList.add('size-' + btn.dataset.size);
        });
        row.querySelectorAll('.illustration-size-btn').forEach(b => b.classList.toggle('on', b === btn));
        refreshPreview();
      });
    });
  });
}
// Uploads immediately (like the article image block) rather than deferring
// to Save -- there's no good way to preview a not-yet-uploaded blob as part
// of the panel's real src the way the OG/banner fields preview a single
// known field, and the dropzone already shows an "Uploading…" state.
function onIllustrationFilePicked(e, region, panelIndex, drop) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const lbl = drop.querySelector('.illustration-drop-lbl');
    if (lbl) lbl.textContent = 'Uploading…';
    try {
      const slug = App.current.slug;
      const ext = (file.name.match(/\.\w+$/) || ['.jpg'])[0];
      // Keeps the original hero-panel path (region 'hero', index 0) exactly
      // as-is, since illustrations already live there in the repo -- any
      // additional panel (e.g. method.html's in-body section-split-img
      // placeholders) gets a disambiguated path so multiple uploads on one
      // page never overwrite each other or the hero's own file.
      const path = (region === 'hero' && panelIndex === 0)
        ? `assets/hero/${slug}/illustration${ext}`
        : `assets/hero/${slug}/illustration-${region}-${panelIndex}${ext}`;
      const existing = await gh.getFile(gh.owner, gh.repo, path, App.branch);
      await gh.putFile(gh.owner, gh.repo, path, bytesToB64(new Uint8Array(reader.result)), `Add illustration for ${slug} via Blacfox CMS`, App.branch, existing ? existing.sha : undefined);
      App.assetCache.delete(`datauri:${App.branch}:${path}`);
      const obj = getCurrentEditable();
      const alt = escHtml((obj && obj.data && obj.data.title) || 'Illustration');
      transformIllustrationPanel(region, panelIndex, el => {
        el.classList.remove('is-placeholder');
        el.classList.add('has-image');
        el.innerHTML = `<img src="${path}" alt="${alt}">`;
      });
      refreshRegionUI(region);
      refreshPreview();
      toast('Illustration uploaded.', 'success');
    } catch (err) {
      const lbl2 = drop.querySelector('.illustration-drop-lbl');
      if (lbl2) lbl2.textContent = 'Upload failed — try again';
      toast('Upload failed: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}
function removeIllustration(region, panelIndex) {
  if (!confirm('Remove this illustration and restore the placeholder? The uploaded image file stays in the repo either way.')) return;
  transformIllustrationPanel(region, panelIndex, el => {
    el.classList.remove('has-image', 'size-sm', 'size-md', 'size-lg');
    // .hero-quote-panel needs the explicit is-placeholder modifier to get
    // the dashed-box look; .section-split-img has no such modifier -- its
    // bare class is already styled as the placeholder, so adding one would
    // just be dead markup.
    if (el.classList.contains('hero-quote-panel')) el.classList.add('is-placeholder');
    el.innerHTML = PLACEHOLDER_ICON_HTML;
  });
  refreshRegionUI(region);
  refreshPreview();
}
function refreshLeafFieldsUI(region) {
  const container = document.getElementById('content-blocks-' + region);
  if (!container) return;
  container.innerHTML = renderLeafFieldsHTML(region);
  wireEditableBoxes(container);
}
function wireContentBlocksUI(region) {
  const container = document.getElementById('content-blocks-' + region);
  if (!container) return;
  container.querySelectorAll('[data-block-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      moveBlock(region, parseInt(btn.dataset.blockIndex, 10), btn.dataset.blockMove);
      refreshContentBlocksUI(region);
      refreshPreview();
    });
  });
  container.querySelectorAll('[data-block-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Remove this section? Unsaved until you hit Save.')) return;
      deleteBlock(region, parseInt(btn.dataset.blockIndex, 10));
      refreshContentBlocksUI(region);
      refreshPreview();
    });
  });
  wireEditableBoxes(container);
}
function refreshContentBlocksUI(region) {
  const container = document.getElementById('content-blocks-' + region);
  if (!container) return;
  container.innerHTML = renderContentBlocksHTML(region);
  wireContentBlocksUI(region);
}
// region: 'hero' has no block chrome (only ever one section, nothing to
// reorder); 'main'/'body' get the full card list. Used after any
// structural change (block add/move/delete) wherever it came from -- the
// sidebar (if that tab happens to be open) and the live preview's floating
// toolbar both funnel through here.
function refreshRegionUI(region) {
  if (region === 'hero') refreshLeafFieldsUI(region);
  else refreshContentBlocksUI(region);
}
// A single text edit (from the preview's click-to-edit, not a structural
// change) only needs its one matching sidebar box updated, not a full
// re-render -- and only if it's not the box currently being typed into.
function syncContentFieldBox(region, index, html) {
  const box = document.querySelector(`.content-editable-box[data-region="${region}"][data-leaf-index="${index}"]`);
  if (box && document.activeElement !== box) box.innerHTML = html;
}

function renderBodyTab() {
  const slug = App.current.slug;
  const p = App.pages[slug];
  return `
    <div class="callout-box">Click any text below — or directly in the live preview — to edit it. Use the arrows to reorder a section, ✕ to remove it, and “+ Insert section” to add a new one.</div>

    <div class="section-title">Hero</div>
    <div id="content-blocks-hero">${renderLeafFieldsHTML('hero')}</div>

    <div class="section-divider"></div>
    <div class="section-title">Main content</div>
    <div id="content-blocks-main">${renderContentBlocksHTML('main')}</div>
    <button class="btn btn-ghost" id="insert-section-btn" style="width:100%;margin:10px 0">+ Insert section</button>

    <details>
      <summary>Advanced: edit raw HTML</summary>
      <div class="field-group" style="margin-top:10px">
        <label class="field-label">Hero <span style="color:#444">(before the content wrap)</span></label>
        <textarea class="field-textarea tall" id="b-hero">${escHtml(p.hero)}</textarea>
      </div>
      <div class="field-group">
        <label class="field-label">Main content <span style="color:#444">(after the content wrap, before the footer)</span></label>
        <textarea class="field-textarea tall" id="b-main" style="min-height:360px">${escHtml(p.main)}</textarea>
      </div>
    </details>

    <button class="btn btn-primary" id="save-body-btn" style="width:100%;padding:10px;margin-top:10px">Save to ${App.branch}</button>
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

/* ---------- Article tabs ---------- */
function renderArticleDetailsTab() {
  const slug = App.current.slug;
  const d = App.articles[slug].data;
  return `
    <div class="callout-box">Editing <b>${slug}.md</b> on branch <b>${App.branch}</b>.</div>

    <div class="field-group"><label class="field-label">Title</label><input class="field-input" id="a-title" value="${escHtml(d.title || '')}"></div>
    <div class="field-group"><label class="field-label">Author</label><input class="field-input" id="a-author" value="${escHtml(d.author || '')}"></div>
    <div class="field-group"><label class="field-label">Date</label><input class="field-input" id="a-date" type="date" value="${escHtml(d.date || '')}"></div>
    <div class="field-group"><label class="field-label">Excerpt <span style="color:#444">(shown on the articles list)</span></label><textarea class="field-textarea" id="a-description" style="min-height:70px">${escHtml(d.description || '')}</textarea></div>

    <div class="section-divider"></div>
    <div class="section-title">Banner image</div>
    <div class="img-drop" id="banner-drop">
      <div class="img-drop-lbl" id="banner-drop-lbl">${d.banner ? d.banner + ' (loading preview…)' : 'Click or drop a JPG — shown at the top of the article and on the articles list'}</div>
      <input type="file" id="banner-file" accept="image/*">
    </div>

    <div class="section-divider"></div>
    <button class="btn btn-primary" id="save-article-meta-btn" style="width:100%;padding:10px">Save to ${App.branch}</button>
    <button class="btn btn-danger" id="delete-article-btn" style="width:100%;padding:10px;margin-top:8px">Delete article</button>
  `;
}
function renderArticleBodyTab() {
  const slug = App.current.slug;
  const a = App.articles[slug];
  return `
    <div class="callout-box">Click any text below — or directly in the live preview — to edit it. Use the arrows to reorder a block, ✕ to remove it, and “+ Insert block” to add headings, images, quotes, or buttons.</div>

    <div id="content-blocks-body">${renderContentBlocksHTML('body')}</div>
    <button class="btn btn-ghost" id="insert-block-btn" style="width:100%;margin:10px 0">+ Insert block</button>

    <details>
      <summary>Advanced: edit raw HTML</summary>
      <div class="field-group" style="margin-top:10px">
        <label class="field-label">Body</label>
        <textarea class="field-textarea tall" id="a-body" style="min-height:420px">${escHtml(a.body)}</textarea>
      </div>
    </details>

    <button class="btn btn-primary" id="save-article-body-btn" style="width:100%;padding:10px;margin-top:10px">Save to ${App.branch}</button>
  `;
}
function wireArticleTabHandlers() {
  if (App.activeTab === 'meta') {
    document.getElementById('a-title').addEventListener('input', e => { App.articles[App.current.slug].data.title = e.target.value; refreshPreview(); });
    document.getElementById('a-author').addEventListener('input', e => { App.articles[App.current.slug].data.author = e.target.value; refreshPreview(); });
    document.getElementById('a-date').addEventListener('input', e => { App.articles[App.current.slug].data.date = e.target.value; refreshPreview(); });
    document.getElementById('a-description').addEventListener('input', e => { App.articles[App.current.slug].data.description = e.target.value; });
    document.getElementById('banner-drop').addEventListener('click', e => { if (e.target.tagName !== 'INPUT') document.getElementById('banner-file').click(); });
    document.getElementById('banner-file').addEventListener('change', onBannerFilePicked);
    document.getElementById('save-article-meta-btn').addEventListener('click', saveArticleMeta);
    document.getElementById('delete-article-btn').addEventListener('click', () => deleteArticle(App.current.slug));
    loadBannerThumbnail();
  } else {
    document.getElementById('save-article-body-btn').addEventListener('click', saveArticleBody);
    document.getElementById('insert-block-btn').addEventListener('click', () => openInsertSectionModal('body', null));
    document.getElementById('a-body').addEventListener('input', syncBodyDraftAndPreview);
    wireContentBlocksUI('body');
  }
}

async function loadBannerThumbnail() {
  const a = App.articles[App.current.slug];
  if (!a.data.banner) return;
  const uri = await fetchAssetDataUri(a.data.banner);
  const drop = document.getElementById('banner-drop');
  if (!drop) return; // user navigated away before this resolved
  const lbl = document.getElementById('banner-drop-lbl');
  if (uri) {
    drop.insertAdjacentHTML('afterbegin', `<img src="${uri}">`);
    if (lbl) lbl.textContent = a.data.banner;
  } else if (lbl) {
    lbl.textContent = a.data.banner + ' (file not found in repo)';
  }
}

let pendingBannerUpload = null;
function onBannerFilePicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingBannerUpload = { name: file.name, bytes: new Uint8Array(reader.result) };
    const blobUrl = URL.createObjectURL(file);
    document.querySelector('#banner-drop img')?.remove();
    document.getElementById('banner-drop').insertAdjacentHTML('afterbegin', `<img src="${blobUrl}">`);
    document.querySelector('#banner-drop-lbl').textContent = file.name + ' (will upload on save)';
  };
  reader.readAsArrayBuffer(file);
}

async function commitArticle(slug, data, body, message) {
  const a = App.articles[slug];
  const content = serializeArticleFrontmatter(data, body);
  const res = await gh.putFile(gh.owner, gh.repo, a.path, b64EncodeText(content), message, App.branch, a.sha);
  App.articles[slug] = { path: a.path, sha: res.content.sha, data, body };
  renderSidebar();
}

async function saveArticleMeta() {
  const slug = App.current.slug;
  const a = App.articles[slug];
  const newData = {
    ...a.data,
    title: document.getElementById('a-title').value.trim(),
    author: document.getElementById('a-author').value.trim(),
    date: document.getElementById('a-date').value.trim(),
    description: document.getElementById('a-description').value.trim(),
  };
  setStatus('saving…', 'busy');
  try {
    if (pendingBannerUpload) {
      const ext = (pendingBannerUpload.name.match(/\.\w+$/) || ['.jpg'])[0];
      const bannerPath = `assets/articles/${slug}/banner${ext}`;
      const existing = await gh.getFile(gh.owner, gh.repo, bannerPath, App.branch);
      await gh.putFile(gh.owner, gh.repo, bannerPath, bytesToB64(pendingBannerUpload.bytes), `Update banner for ${slug} via Blacfox CMS`, App.branch, existing ? existing.sha : undefined);
      newData.banner = bannerPath;
      App.assetCache.delete(`datauri:${App.branch}:${bannerPath}`);
      pendingBannerUpload = null;
    }
    await commitArticle(slug, newData, a.body, `Update ${slug} details via Blacfox CMS`);
    toast(`Saved ${slug}.md`, 'success');
    setStatus('saved', 'ok');
    refreshPreview();
  } catch (e) {
    setStatus('error', 'error');
    toast('Save failed: ' + e.message, 'error');
  }
}

async function saveArticleBody() {
  const slug = App.current.slug;
  const a = App.articles[slug];
  const body = document.getElementById('a-body').value;
  setStatus('saving…', 'busy');
  try {
    await commitArticle(slug, a.data, body, `Update ${slug} body via Blacfox CMS`);
    toast(`Saved ${slug}.md`, 'success');
    setStatus('saved', 'ok');
    refreshPreview();
  } catch (e) {
    setStatus('error', 'error');
    toast('Save failed: ' + e.message, 'error');
  }
}

// region: 'main' (pages) or 'body' (articles). insertIndex: a specific
// block position (from a preview "+" gap click) or null to append at the
// end (from the sidebar "+ Insert section"/"+ Insert block" button).
function openInsertSectionModal(region, insertIndex) {
  const isArticle = App.current.type === 'article';
  const compSet = isArticle ? BLOG_COMPONENTS : COMPONENTS;
  const items = Object.entries(compSet).map(([key, c]) => `<div class="comp-picker-item" data-comp="${key}"><strong>${c.label}</strong>${c.hint}</div>`).join('');
  openModal(`<div class="modal-title">Insert ${isArticle ? 'block' : 'section'}</div><div class="comp-picker-grid">${items}</div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button></div>`);
  document.querySelectorAll('.comp-picker-item').forEach(el => el.addEventListener('click', () => {
    const key = el.dataset.comp;
    if (key === 'image') { openArticleImageModal(region, insertIndex); return; }
    openComponentForm(compSet, key, region, insertIndex);
  }));
}

function openComponentForm(compSet, key, region, insertIndex) {
  const c = compSet[key];
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
    insertBlockAt(region, insertIndex, html);
    closeModal();
    refreshRegionUI(region);
    refreshPreview();
    toast(`${c.label} inserted — check the preview, then Save when you're happy with it.`, 'success');
  });
}

// Images upload straight away (unlike the OG-image field, which defers
// until Save) so the picker's "Insert" step can drop a real, already-live
// <img src> into the block -- there's no good way to preview a not-yet-
// uploaded blob inline as part of arbitrary HTML the way the OG dropzone
// previews a single known field.
function openArticleImageModal(region, insertIndex) {
  openModal(`
    <div class="modal-title">Insert image</div>
    <div class="img-drop" id="ai-drop">
      <div class="img-drop-lbl" id="ai-drop-lbl">Click or drop a JPG/PNG</div>
      <input type="file" id="ai-file" accept="image/*">
    </div>
    <div class="field-group" style="margin-top:10px"><label class="field-label">Alt text</label><input class="field-input" id="ai-alt" placeholder="Describe the image"></div>
    <div class="field-group"><label class="field-label">Caption (optional)</label><input class="field-input" id="ai-caption" placeholder="Shown under the image"></div>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="ai-insert" disabled>Insert image</button></div>
  `);
  let picked = null;
  document.getElementById('ai-drop').addEventListener('click', e => { if (e.target.tagName !== 'INPUT') document.getElementById('ai-file').click(); });
  document.getElementById('ai-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      picked = { name: file.name, bytes: new Uint8Array(reader.result) };
      const blobUrl = URL.createObjectURL(file);
      document.querySelector('#ai-drop img')?.remove();
      document.getElementById('ai-drop').insertAdjacentHTML('afterbegin', `<img src="${blobUrl}">`);
      document.getElementById('ai-drop-lbl').textContent = file.name;
      document.getElementById('ai-insert').disabled = false;
    };
    reader.readAsArrayBuffer(file);
  });
  document.getElementById('ai-insert').addEventListener('click', async () => {
    if (!picked) return;
    const btn = document.getElementById('ai-insert');
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const slug = App.current.slug;
      const ext = (picked.name.match(/\.\w+$/) || ['.jpg'])[0];
      const safeName = 'img-' + Date.now() + ext;
      const path = `assets/articles/${slug}/${safeName}`;
      await gh.putFile(gh.owner, gh.repo, path, bytesToB64(picked.bytes), `Add image to ${slug} via Blacfox CMS`, App.branch);
      App.assetCache.delete(`datauri:${App.branch}:${path}`);
      const alt = escHtml(document.getElementById('ai-alt').value.trim());
      const caption = document.getElementById('ai-caption').value.trim();
      const html = caption
        ? `<figure><img src="${path}" alt="${alt}" loading="lazy">\n  <figcaption>${escHtml(caption)}</figcaption></figure>`
        : `<img src="${path}" alt="${alt}" loading="lazy">`;
      insertBlockAt(region, insertIndex, html);
      closeModal();
      refreshRegionUI(region);
      refreshPreview();
      toast('Image inserted — Save when you\'re happy with it.', 'success');
    } catch (e) {
      toast('Image upload failed: ' + e.message, 'error');
      btn.disabled = false; btn.textContent = 'Insert image';
    }
  });
}

/* ---------- Nav tab ---------- */
function getNavLinks() {
  const navEl = App.navDoc.doc.querySelector('.nav-links-list');
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
  const navEl = App.navDoc.doc.querySelector('.nav-links-list');
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
  // Fetched in parallel -- these are independent GitHub API calls, and doing
  // them one-at-a-time (the original approach) turned every image/icon on
  // the page into its own sequential network round-trip, which is what made
  // the preview take ages to reveal on anything but a bare-bones page.
  const entries = await Promise.all([...paths].map(async path => [path, await fetchAssetDataUri(path)]));
  for (const [path, uri] of entries) {
    if (uri) html = html.split(path).join(uri);
  }
  return html;
}

// Shared by both buildPreviewHTML and buildArticlePreviewHTML: inlines local
// stylesheets/scripts as text, then every remaining relative asset reference
// (images, fonts, SVG backgrounds) as a data: URI fetched through the
// authenticated API rather than a public raw-content URL -- this is what
// makes the preview work against a private repo.
async function inlineLocalAssets(html) {
  // Both passes below fetch every matched file in parallel (Promise.all)
  // rather than one at a time -- a page can reference several stylesheets
  // and scripts, and awaiting each in turn stacked up their full GitHub API
  // round-trip latencies instead of overlapping them.
  const linkRe = /<link rel="stylesheet" href="([^"]+)">/g;
  const linkMatches = [...html.matchAll(linkRe)].filter(m => !/^https?:/.test(m[1])); // external (Google Fonts) — leave as-is, real MIME type
  const linkTexts = await Promise.all(linkMatches.map(m => fetchAssetText(m[1])));
  linkMatches.forEach((m, i) => {
    const text = linkTexts[i];
    html = html.replace(m[0], text != null ? `<style>/* ${m[1]} */\n${text}\n</style>` : '');
  });

  const scriptRe = /<script src="([^"]+)"[^>]*><\/script>/g;
  const scriptMatches = [...html.matchAll(scriptRe)].filter(m => !/^https?:/.test(m[1]));
  const scriptTexts = await Promise.all(scriptMatches.map(m => fetchAssetText(m[1])));
  scriptMatches.forEach((m, i) => {
    const text = scriptTexts[i];
    html = html.replace(m[0], text != null ? `<script>${text}</script>` : '');
  });

  html = await inlineAssetRefs(html);
  return html;
}

/* ------------------------------------------------------------
   Article rendering -- must match build.js's renderArticleHero /
   renderArticlePage / renderArticlesGrid exactly, same reasoning
   as the page LAYOUTS/renderHead/renderPage mirror above.
   ------------------------------------------------------------ */
function renderArticleHeroClient(data) {
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
function renderArticlePageClient(data, bodyHtml, partials) {
  const layout = LAYOUTS.inner;
  const bodyClassAttr = data.bodyClass ? ` class="${data.bodyClass}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
${renderHeadClient(partials.head, data)}
</head>
<body${bodyClassAttr}>
<div aria-hidden="true" style="position:fixed;top:0;left:0;width:100%;height:8px;z-index:1001;pointer-events:none;background-image:url('assets/icons/accent-strip.svg');background-size:100% 100%;background-repeat:no-repeat;"></div>

${partials.nav}
${renderArticleHeroClient(data)}
<div id="${layout.spacerId}"></div>
${layout.wrapOpen}

<div class="article-body" id="cms-article-body-root">
${bodyHtml}
</div>

${partials.footer}

${layout.wrapClose}
<script src="assets/js/hero-bg-grid.js"></script>
<script src="assets/js/nav.js"></script>
<script src="segment-gate.js" defer></script>
</body>
</html>`;
}
// The one piece of "cms-generated" content that gets spliced into a real
// page (pages/articles.md, at its <!--ARTICLES-GRID--> marker) rather than
// rendered as its own page -- see the cms-generated skip in
// collectEditableLeaves/wireBlocks for why it's marked as such.
function renderArticlesGridClient(articles) {
  const sorted = articles.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!sorted.length) {
    return `<p class="section-p cms-generated" style="text-align:center">No articles published yet — check back soon.</p>`;
  }
  return `<div class="card-grid-3 stagger article-grid cms-generated">
${sorted.map(a => `  <a class="dark-card article-card" href="article-${a.slug}.html">
    <div class="article-card-thumb">${a.banner ? `<img src="${a.banner}" alt="${escHtml(a.title || '')}" loading="lazy">` : ''}</div>
    <p class="card-num">${escHtml(formatArticleDate(a.date))}</p>
    <p class="card-title">${escHtml(a.title || 'Untitled')}</p>
    <p class="card-body">${escHtml(a.description || '')}</p>
  </a>`).join('\n')}
</div>`;
}

async function buildPreviewHTML(slug) {
  const p = App.pages[slug];
  const [headText, navFile, footerFile] = await Promise.all([
    fetchAssetText('partials/head.html'),
    gh.getFile(gh.owner, gh.repo, 'partials/nav.html', App.branch),
    gh.getFile(gh.owner, gh.repo, 'partials/footer.html', App.branch),
  ]);
  // "display:contents" is layout-invisible -- this wrapper exists purely so
  // the edit script (and applyInlineEdit's parsing on the other end) has a
  // stable root to address hero content by, without affecting the real
  // build.js output at all (this wrapping never happens there).
  const heroWrapped = `<div id="cms-hero-root" style="display:contents">${p.hero}</div>`;
  let mainHtml = p.main;
  if (mainHtml.includes('<!--ARTICLES-GRID-->')) {
    const list = Object.entries(App.articles).map(([slug, a]) => ({ slug, ...a.data }));
    mainHtml = mainHtml.replace('<!--ARTICLES-GRID-->', renderArticlesGridClient(list));
  }
  let html = renderPageClient(p.data, heroWrapped, mainHtml, { head: headText, nav: navFile.text.trim(), footer: footerFile.text.trim() });
  html = await inlineLocalAssets(html);
  html = html.replace('</body>', `${buildPreviewEditScript(App.previewEditMode)}</body>`);
  return html;
}

async function buildArticlePreviewHTML(slug) {
  const a = App.articles[slug];
  const [headText, navFile, footerFile] = await Promise.all([
    fetchAssetText('partials/head.html'),
    gh.getFile(gh.owner, gh.repo, 'partials/nav.html', App.branch),
    gh.getFile(gh.owner, gh.repo, 'partials/footer.html', App.branch),
  ]);
  let html = renderArticlePageClient(a.data, a.body, { head: headText, nav: navFile.text.trim(), footer: footerFile.text.trim() });
  html = await inlineLocalAssets(html);
  html = html.replace('</body>', `${buildPreviewEditScript(App.previewEditMode)}</body>`);
  return html;
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(doRefreshPreview, 250);
}
async function doRefreshPreview() {
  const isPreviewable = App.current && (App.current.type === 'page' || App.current.type === 'article');
  if (!isPreviewable) {
    document.getElementById('preview-empty').style.display = 'flex';
    document.getElementById('preview-frame').style.display = 'none';
    document.getElementById('preview-url').textContent = App.current ? `${App.current.type} (no page preview)` : 'Select a page to preview';
    return;
  }
  const slug = App.current.slug;
  const isArticle = App.current.type === 'article';
  document.getElementById('preview-url').textContent = `${isArticle ? 'article-' + slug : slug}.html — ${App.branch}`;
  try {
    const html = isArticle ? await buildArticlePreviewHTML(slug) : await buildPreviewHTML(slug);
    const frame = document.getElementById('preview-frame');
    frame.srcdoc = html;
    frame.style.display = '';
    document.getElementById('preview-empty').style.display = 'none';
  } catch (e) {
    toast('Preview failed: ' + e.message, 'error');
  }
}
// Stylesheets/scripts/images referenced by a page are cached in memory for
// the life of this browser tab (App.assetCache) so typing doesn't re-fetch
// heavy CSS/image blobs on every keystroke -- but that means if the
// underlying file changes on this branch *outside* the CMS (another editor
// saving it, or a code change pushed directly) while this tab stays open,
// the preview keeps rendering the stale cached copy indefinitely. The
// Refresh button is the one place that should always mean "no really, get
// me the current content," so it clears the cache first.
document.getElementById('refresh-preview-btn').addEventListener('click', () => {
  App.assetCache.clear();
  refreshPreview();
});

function updateEditModeBtn() {
  const btn = document.getElementById('edit-mode-btn');
  btn.classList.toggle('btn-primary', App.previewEditMode);
  btn.classList.toggle('btn-ghost', !App.previewEditMode);
  btn.textContent = App.previewEditMode ? '✏️ Editing on page — click text to edit' : '✏️ Edit on page';
}
document.getElementById('edit-mode-btn').addEventListener('click', () => {
  App.previewEditMode = !App.previewEditMode;
  updateEditModeBtn();
  refreshPreview();
});
updateEditModeBtn();
