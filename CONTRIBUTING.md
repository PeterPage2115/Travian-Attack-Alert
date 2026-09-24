# Contributing to Travian Attack Alert

Thank you for considering a contribution. This project is a Tampermonkey userscript (release candidate `1.0.2` / `taa-1.0.2`) with a small, strict workflow. Please read this file, `AGENTS.md`, and `SECURITY.md` before opening a pull request.

## Ground rules

- **Single source of truth:** `package.json` (`version`, currently `1.0.2`). Version bumps follow semver (patch = fix, minor = new feature, major = storage/schema break) and must sync `package.json`, the generated `dist/` header, `RELEASE` records, `tools/*` fallbacks, test assertions, and `README.md`.
- **Node.js >= 18** (see `.node-version` and `package.json` `engines`). Dependencies are installed with `npm ci`.
- **Tests are `node:test`, offline only.** `npm test` must be fully green (zero failures). Fixtures are deterministic loopback fixtures — never add real webhooks or requests to Travian.
- **Build with esbuild via `npm run build`.** `src/` is the editable authority; `dist/travian-attack-alert.user.js` is generated and must never be hand-edited.
- **No runtime dependencies in the browser.** The userscript ships with zero runtime deps. Dev-only tools are `esbuild`, `playwright`, and `typescript` (for tools/tests). Do not add a runtime dependency without asking first.
- **Back up before editing `src/` or `config/`.** Run `npm run backup` before every edit of those trees. Roll back only via `node tools/rollback.cjs <selector>`, then `npm run build`. Never clear site data to "fix" state — clearing storage destroys the roster, mappings, and role configuration with no recovery.
- **Secrets stay out of the repo.** Discord webhooks live only in `GM_setValue` / the Tampermonkey menu. Never commit webhook URLs, tokens, cookies, passwords, raw page HTML, or full settings exports. `backups/` and `.env*` are gitignored. See `SECURITY.md`.

## Panel vs menu boundary

Respect the product boundary (enforced by `test/tools/readme-runtime-contract.test.cjs`):

- **Panel** = daily work: Overview (read-only), Players CRUD, thresholds, attack/leave roles, test send.
- **Tampermonkey menu** = setup + recovery: webhook, retry/flush, debug, emergency import/export, incident bundle.
- Standby without a lease is read-only; losing the lease disables mutations immediately.

## Architecture in brief

- Entry: `src/userscript-entry.js` → `src/runtime.js`. `src/` holds 13 domain modules (`storage`, `lease`, `parser`, `snapshot`, `envelope`, `migration`, `discord`, `transport`, `dispatch`, `conservation`, `diagnostics`, `panel`, `acquisition`); each `X.js` facade re-exports its `X-impl.js` contract by reference. `constants` / `text` / `route` are pure modules covered by `pure-module-parity`.
- `src/runtime-api.js` is a thin aggregator over the 13 facades (reference-equal, no `select()`). `src/lifecycle.js` owns mutable lifecycle singletons; `src/adapters.js` provides the 7 seam factories. `src/runtime.js` is the legacy authority. Boundaries are enforced by `test/tools/module-architecture.test.cjs`.
- Design tokens live in `docs/architecture.md`. Documentation entry routing: the index is `docs/README.md`; daily operations are English `docs/OPERATIONS.md` (primary) and Polish `docs/pl/OPERATIONS.md` (secondary, English governs disagreements); the alert payload contract is `docs/ALERT-FORMAT.md`.

## Workflow

1. Fork and create a topic branch.
2. `npm ci`
3. `npm run backup` (required before touching `src/` or `config/`).
4. Make your change (keep it minimal; docs-only changes must not touch `dist/` bytes).
5. `npm run build`
6. `npm run check:artifact` (syntax + artifact checks).
7. `npm test` (must be green: `test:offline` + `test:tools` + `test:artifact`).
8. For release-adjacent work also run `npm run check`, `npm run check:types`, and `npm run quality` as CI does (see `.github/workflows/ci.yml`).
9. Commit with a clear message and open a PR against the release branch using the PR template.

Quick syntax check:

```text
node -e "new Function(require('fs').readFileSync('dist/travian-attack-alert.user.js','utf8'))"
```

## Pull requests

- Fill in `.github/pull_request_template.md` completely: tests run, `dist/` rebuilt via `npm run build` (or state docs-only), no new runtime deps, backup done before `src/`/`config/` edits.
- One logical change per PR. Keep diffs reviewable.
- CI is read-only (verify + upload evidence, never publish). It runs the build, offline/tools/artifact gates, checks, type and quality ratchets, privacy/secret scans, and browser/e2e gates — your PR must pass all of them.

## Issues

- **Bug reports:** use `.github/ISSUE_TEMPLATE/bug_report.yml`. Include script version + release ID, browser/manager versions, numbered reproduction steps on fixture or redacted data, expected vs actual behavior, and the redacted incident bundle (`Diagnostics` tab → `Export incident bundle`, max 512 KiB). Never paste secrets.
- **Feature requests:** use `.github/ISSUE_TEMPLATE/feature_request.yml`. Describe the problem, the proposed behavior, panel-vs-menu placement, and acceptable alternatives.
- **Security:** follow `SECURITY.md` — report privately through GitHub Private Vulnerability Reporting / Security Advisories. Never open a public issue for a vulnerability and never paste secrets or player data.

## Support

Support is entirely voluntary and has no influence on features, priorities, or fix timelines. There is no paid tier. See `README.md` § Support for what to include in a report.
