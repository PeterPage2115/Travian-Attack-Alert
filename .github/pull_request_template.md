<!--
  PR template for Travian Attack Alert (1.0.0 / taa-1.0.0).
  Fill in every section. CI is read-only: build + offline/tools/artifact
  gates, checks, type/quality ratchets, privacy scans, browser/e2e gates.
-->

## Summary

<!-- What does this PR change and why? One logical change per PR. -->

## Type

<!-- Mark one: fix / feature / docs / chore / refactor / test / tools -->

- [ ] fix
- [ ] feature
- [ ] docs-only (no `src/`/`config/` change, no `dist/` rebuild needed)
- [ ] chore / refactor / test / tools

## Checklist (required)

- [ ] Tests pass: `npm test` is green (offline + tools + artifact, zero failures)
- [ ] `dist/` rebuilt via `npm run build` (or N/A for docs-only — `dist/` is generated, never hand-edited)
- [ ] `npm run check:artifact` passes (plus `npm run check` / `check:types` / `quality` for release-adjacent work)
- [ ] No new runtime dependencies (browser ships zero runtime deps; dev-only: esbuild, playwright, typescript)
- [ ] Backup done before `src/`/`config/` edits (`npm run backup`); rollback path is `node tools/rollback.cjs <selector>` + rebuild, without clearing site data
- [ ] Deterministic fixtures only — no real webhooks, no requests to Travian, no secrets in code/logs/exports
- [ ] Panel-vs-menu boundary respected (panel = daily work; menu = setup + recovery)

## Verification

<!-- Commands run and their result, e.g. `npm run build`, `npm test`. -->

```text
npm run build
npm run check:artifact
npm test
```

## Docs / version sync (if applicable)

<!-- Semver source of truth is package.json. List synced places: package.json, dist header, RELEASE, tools/* fallback, test assertions, README. -->

- [ ] No version bump needed / version sync completed

## Related issues

<!-- e.g. Closes #123 -->

## Incident / privacy note

<!-- Confirm: no webhook URLs, tokens, cookies, passwords, raw HTML, or full settings exports in this PR. Redacted incident bundle attached where relevant. -->
