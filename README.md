# Blacfox Website — Collaborative Design

Static HTML/CSS/JS build of the new Blacfox marketing site. This is the
design-first foundation of the project: [Lovable](https://lovable.dev) will
build on top of it to add the site's remaining facilities (auth, CMS, forms
backend, etc.).

**Status: dev / pre-launch.** The production site is not live yet — this repo
is a working design environment, not a deployed site.

## Structure

```
.
├── index.html, about.html, ...       one static page per route (plain relative links between them)
├── assets/
│   ├── css/
│   │   ├── fonts.css                 self-hosted Montserrat — shared by every page
│   │   ├── site.css                  shared base stylesheet, used by pages that haven't diverged from it
│   │   └── pages/<page>.css          full stylesheet for a page whose design has diverged from site.css
│   ├── js/
│   │   ├── hero-bg-grid.js           shared canvas hero-background animation
│   │   ├── vendor/chart.umd.min.js   vendored Chart.js — used by for-partners.html and work.html
│   │   └── pages/<page>.js           page-specific script (hero spacer sync, etc.)
│   ├── logos/, elements/, icons/     SVGs referenced by the pages
└── design-source/
    └── Web Elements.ai               Illustrator source for the SVGs in assets/ (not used at runtime)
```

Every page links `assets/css/fonts.css`, then **either** `assets/css/site.css`
**or** its own `assets/css/pages/<page>.css` — never both. A page only gets a
`pages/<page>.css` file once its design has diverged from the shared
baseline. If you're changing a rule that should apply site-wide, check
`site.css` first; if the page you're editing already has its own
`pages/<page>.css`, the shared rule won't reach it automatically.

This repo was migrated from a set of self-contained, single-file HTML page
exports (each ~2MB, with fonts/CSS/images duplicated inline in every file).
The content above is unchanged from that export — only *where the bytes
live* changed, to make the site maintainable by more than one person.

## Known gaps

- Every page references `segment-gate.css` and `segment-gate.js` (a planned
  audience-segmentation/gating feature). Neither file exists in this repo —
  that's intentional, not a bug introduced by this migration. It's expected
  to land as part of the auth/CMS work Lovable is doing next.
- `index.html`'s footer links to `seo-checklist.html`, which doesn't exist
  yet either. Pre-existing gap from the original design export, not
  introduced by this migration.

## Working on this repo

**Always `git pull` before making changes** — this is a shared,
multi-developer project.

There's no build step: it's plain static HTML/CSS/JS. Open any `.html` file
directly in a browser, or serve the folder with any static file server
(e.g. `npx serve .`).
