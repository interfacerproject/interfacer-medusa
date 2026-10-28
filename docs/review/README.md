# Medusa reviewers’ field guide

Canonical evidence snapshot: **2026-10-26** (P7 outbox, P8 real actors, P9
enforced Zenflows authz). Implementation pins are the tested backend `8018cb4`
and GUI `f76a53e`; documentation commits can follow them. Previous snapshot:
2026-10-23 (`ef02bdb` / `9c503df`).

- `field-guide.mjs`: canonical equivalent English/Italian chapter.
- `build.mjs`: builds the standalone `index.html`; no dependencies.
- `review.css`: preserves the original Claude Medusa artifact’s paper/green
  visual treatment; no remote font, analytics or application API calls.
- `review.js`: language/theme controls, no application credentials.
- `field-guide-integration.patch`: integration into the existing sibling local
  `authz-field-guide`, which is not a Git repository of its own. Apply from that
  directory with `git apply --unidiff-zero <path-to-field-guide-integration.patch>`
  (the patch intentionally has zero context to avoid trailing-space context lines).

Run `npm run docs:review` and `npm run test:review` from the Medusa repository.
Website-only browser QA: `node docs/review/browser.cjs` (uses this repository’s
existing Playwright install and the running local field guide). Verified: 2
standalone tests, 8 existing-site tests, bilingual desktop/mobile browser checks
for both renderers, no overflow, page errors or external requests. Generated
captures are ignored under `.tmp/review-site/`; no application API is called.
Open `index.html` directly or serve this directory as static files.
The existing local reviewer site also renders this chapter at
http://127.0.0.1:3110/it/medusa.html and /en/medusa.html, including navigation,
source pins, search and bilingual Markdown export.

PRs: [Medusa #1](https://github.com/interfacerproject/interfacer-medusa/pull/1),
[GUI #922](https://github.com/interfacerproject/interfacer-gui/pull/922), stacked
on [GUI #921](https://github.com/interfacerproject/interfacer-gui/pull/921).
Runtime compatibility: Zenflows #84 and locally built/linked SDK #7.

The Claude-hosted artifact
https://claude.ai/artifact/T61prEye93qEnT1eSD4LaC is a shareable summary page.
It was refreshed on 2026-10-27 to the same state (outbox, real sellers, enforced
authz, PR map), at the same link. This versioned guide and the local reviewer site
remain the maintained copies with pinned sources. None of these is a production
deployment.
