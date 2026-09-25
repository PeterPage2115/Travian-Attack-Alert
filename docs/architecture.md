# TravianAttackAlert Design System — 1.0.2 attack-only

This is the source of truth for the vanilla operations console at **1.0.2**. Values marked **EXTRACTED** are preserved from `initAdminPanel` and its helper seam in `src/runtime.js`; **PROPOSED** values complete the approved warm-charcoal + brass/olive direction and must be used as tokens rather than ad-hoc overrides.

## 1. Atmosphere & Identity

The panel is a restrained operations console: quiet enough for long configuration work, dense enough to scan during an attack wave. Its signature is a warm charcoal shell with brass interaction edges and an olive operational signal, while red/amber/green are reserved for semantic health. The visual order is delta first, status second, controls third; surfaces gain hierarchy through tonal shifts and one deliberate dialog shadow, never decorative gradients or remote assets.

Personas: the alliance coordinator needs fast delta recognition; the mapper needs durable typed work; the keyboard/screen-reader operator needs semantic landmarks, labels, live feedback, and predictable focus; the constrained operator needs a single scroll owner, reflow at 375 px/200% zoom, reduced motion, and forced-colors resilience.

## 2. Color

### CSS custom properties

```css
:root {
  --ta-bg: #080d14;                 /* EXTRACTED: initAdminPanel overlay rgba base */
  --ta-surface: #101923;            /* EXTRACTED: panel background */
  --ta-surface-raised: #14212d;     /* EXTRACTED: .taa-section background */
  --ta-surface-input: #182633;      /* EXTRACTED: .taa-input background */
  --ta-surface-control: #26384a;    /* EXTRACTED: .taa-button background */
  --ta-border: #40536a;             /* EXTRACTED: panel/input/section border */
  --ta-border-subtle: #53677c;      /* PROPOSED: readable tonal divider */
  --ta-border-strong: #65798e;      /* PROPOSED: AA input boundary (>=3:1 on raised/input surfaces) */
  --ta-text: #edf3f7;               /* EXTRACTED: panel/input/list text */
  --ta-text-muted: #a9d6a1;         /* EXTRACTED: feedback/label/empty text */
  --ta-text-disabled: #82909b;      /* PROPOSED: disabled text that remains legible */
  --ta-accent: #d7a23a;             /* EXTRACTED: button border/focus outline */
  --ta-accent-hover: #ffe8a6;       /* EXTRACTED: hover text, focus border */
  --ta-accent-olive: #9aa66f;       /* PROPOSED: approved olive interaction accent */
  --ta-accent-olive-strong: #c2cc8b;/* PROPOSED: olive hover/focus companion */
  --ta-status-red: #ffb4ab;         /* PROPOSED: semantic error ramp, AA on charcoal */
  --ta-status-red-strong: #ff8f86;  /* PROPOSED: strong error edge */
  --ta-status-amber: #f5c36b;       /* PROPOSED: semantic warning ramp */
  --ta-status-amber-strong: #d99a2b;/* PROPOSED: warning edge */
  --ta-status-green: #a9d6a1;       /* EXTRACTED: existing success/empty color */
  --ta-status-green-strong: #77b56f;/* PROPOSED: success edge */
  --ta-focus-ring: #ffe8a6;         /* EXTRACTED: input focus border */
  --ta-on-accent: #101923;          /* PROPOSED: dark text on brass */
  --ta-border-width: 1px;           /* EXTRACTED: existing borders */
  --ta-focus-width: 2px;            /* EXTRACTED: input outline */
  --ta-panel-max: 940px;            /* EXTRACTED: panel width */
}
```

The extracted rgba overlay is represented by `--ta-bg` plus `--ta-overlay-alpha: .78` (EXTRACTED from `rgba(8, 13, 20, 0.78)`); alpha is a compositing mechanic, not a new color. Accent is interactive-only. Semantic ramps are never used as the sole carrier of meaning: every status includes a word, label, or icon-free text marker. Contrast target is WCAG 2.2 AA: body pairs >=4.5:1, large text and UI boundaries >=3:1. Todo 7 amendment: the EXTRACTED `--ta-border` measures 2.25:1 on `--ta-surface`, so interactive input boundaries use the PROPOSED `--ta-border-strong` (#65798e; 3.43–3.95:1 across input/raised/surface), while section shells keep `--ta-border` (grouping is identified by headings and spacing, not boundary-critical).

Injected ownership is explicit: both `#taa-open-panel` and `#taa-panel-overlay` receive the shared launcher/panel token block under their owned roots, never on the host page's `:root`. The recovery path also carries literal fallbacks for inset (`auto 16px 16px auto`), border (`1px solid #d7a23a`), radius (`6px`), padding (`8px 12px`), surface/text (`#26384a`/`#ffe8a6`), system font, and a `2px solid #ffe8a6` focus outline. The literals duplicate existing token values so hostile host rules cannot blank the launcher before custom properties resolve.

## 3. Typography

```css
:root {
  --ta-font-system: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --ta-font-mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  --ta-text-xs: 0.6875rem; /* 11px EXTRACTED: .taa-label-text/.taa-small-button */
  --ta-text-sm: 0.75rem;   /* 12px EXTRACTED: feedback */
  --ta-text-md: 0.8125rem; /* 13px EXTRACTED: section title */
  --ta-text-body: 0.875rem;/* 14px PROPOSED AA body floor */
  --ta-text-lg: 1.0625rem; /* 17px EXTRACTED: panel title */
  --ta-leading-tight: 1.2;
  --ta-leading-body: 1.45;  /* EXTRACTED: panel line-height */
  --ta-leading-relaxed: 1.6;
  --ta-label-tracking: .02em;       /* EXTRACTED: .taa-label-text */
}
```

Use the system stack for prose and headings; use the mono stack for IDs, timestamps, counts, and operational values. All numeric data uses `font-variant-numeric: tabular-nums`. Labels may use the mono stack with positive tracking. No remote font is permitted; no text is smaller than `--ta-text-xs` for metadata or `--ta-text-body` for primary body copy.

## 4. Spacing & Layout

All intent derives from a 4 px base: `--ta-space-1: 4px`, `--ta-space-2: 8px`, `--ta-space-3: 12px`, `--ta-space-4: 16px`, `--ta-space-5: 20px`, `--ta-space-6: 24px`, `--ta-space-8: 32px`, `--ta-space-10: 40px`, `--ta-space-12: 48px`. Mechanics such as `auto`, `%`, `min()`, `clamp()`, and intrinsic sizing remain raw CSS mechanics.

The dialog shell is the only scroll owner: overlay `overflow-y: auto`, panel content never creates a nested scrolling list. The panel uses `max-inline-size: 940px` (EXTRACTED), `min-inline-size: 0`, and responsive gutters of `--ta-space-3` through `--ta-space-6`. Content uses a one-column flow at 375 px and a `minmax(min(100%, 280px), 1fr)` grid at wider widths (EXTRACTED). Long IDs and URLs use `overflow-wrap: anywhere`; no primary content may cause horizontal page scroll. Breakpoints are 640 px and 768 px; showcase evidence is required at 375/768/1280.

## 5. Components

Every primitive below is present in `test/fixtures/design-system/showcase.html`. State names are stable hooks for Playwright and future `src/` runtime helpers.

### Dialog shell
- **Structure**: `<div data-primitive="dialog-shell" role="dialog" aria-modal="true" aria-labelledby="…">` with `<header>`, live feedback, and `<main>`.
- **States**: default/open, focus on close, loading content, error feedback, standby banner, close/return-focus.
- **Tokens**: `--ta-bg`, `--ta-surface`, `--ta-border`, `--ta-space-4/6`, `--ta-radius-dialog`, `--ta-shadow-dialog`.
- **Accessibility/layout**: one scroll owner; `Escape` and close return focus; heading is the accessible name; no nested list scroll.

### Tablist / tab / panel
- **Structure**: `<nav aria-label="Monitor views"><div role="tablist"><button role="tab" aria-controls="…" aria-selected="…">`; panel uses `role="tabpanel" tabindex="0"`.
- **States**: default, hover, active/selected, focus, disabled, loading panel, empty panel, error panel, standby panel.
- **Tokens**: `--ta-accent`, `--ta-accent-hover`, `--ta-border`, `--ta-space-2/3`.
- **Accessibility**: arrow keys may move selection; selected state is also text/structure, never color-only.

### Status strip
- **Structure**: `<section aria-labelledby="…"><h2>Health</h2><dl>` with labelled values and a text status marker.
- **States**: healthy/green, warning/amber, error/red, standby/olive, loading.
- **Tokens**: semantic ramps, `--ta-surface-raised`, `--ta-border-subtle`, `--ta-font-mono`.

### `inline-checkbox-filter` — Inline checkbox filter
- **Structure**: visible labelled `<label><input type="checkbox">` controls in one wrapping group; mapped, unmapped, muted, and orphaned filters are nonexclusive.
- **States**: unchecked, checked, disabled/standby, focus-visible.
- **Tokens**: `--ta-space-2/3`, `--ta-text-muted`, `--ta-accent`, `--ta-focus-ring`, `--ta-font-mono`.

### `status-count-strip` — Status-count strip
- **Structure**: compact `<dl>` of monitored, mapped, unmapped, muted, and orphaned counts; each value has a text label and tabular number.
- **States**: populated, zero, loading, standby.
- **Tokens**: `--ta-surface-raised`, `--ta-border-subtle`, semantic ramps, `--ta-font-mono`, `--ta-space-2/3`.

### `pagination-control` — Pagination control
- **Structure**: labelled result/page live text plus native Previous/Next buttons and a current-page indicator.
- **States**: first page, middle page, last page, disabled/standby.
- **Tokens**: button variants, `--ta-space-2/3`, `--ta-text-muted`, `--ta-font-mono`.
- **Scroll contract**: pagination replaces the nested list scroller; `#taa-panel-overlay` remains the sole scroll owner.

### Button variants
- **Structure**: native `<button type="button">` with visible text.
- **Variants**: primary brass, secondary olive, quiet, destructive.
- **States**: default, hover, active, focus-visible, disabled, loading (`aria-busy="true"` with text retained).
- **Tokens**: `--ta-accent`, `--ta-accent-hover`, `--ta-accent-olive`, `--ta-status-red`, `--ta-space-2/3`, `--ta-radius-control`.

### Labelled field
- **Structure**: `<label for="…">` + native `<input>` and optional `<small id="…-hint">`; errors use `aria-describedby` and `aria-invalid`.
- **States**: default, focus, disabled, loading/read-only, error, valid.
- **Tokens**: `--ta-text`, `--ta-text-muted`, `--ta-surface-input`, `--ta-border`, `--ta-focus-ring`, `--ta-space-2`.

### Inline feedback
- **Structure**: `<p role="status" aria-live="polite">` for success/loading and `<p role="alert">` for errors; always includes words.
- **States**: loading, success, error, standby, empty.
- **Tokens**: semantic ramps and `--ta-space-2`.

### `compact-player-row` — Compact player row
- **Structure**: labelled search input + `<ul>` of `<li><article>`; each compact row has heading, profile ID, mapped/unmapped/muted/orphaned state text, and a real action button.
- **States**: mapped, unmapped, muted, orphaned, hover, focus on action, loading row, empty result, error result, standby/read-only. State meaning is always text, never color-only.
- **Tokens**: `--ta-surface-raised`, `--ta-border-subtle`, `--ta-space-3/4`, mono numeric styles.
- **Accessibility**: list count is text; filtering does not remove the search label; long values wrap.

### `inline-editor-confirmation` — Inline editor + confirmation group
- **Structure**: the compact row expands to a labelled inline editor for recipient values; destructive removal uses the existing `<fieldset>`/`<legend>` confirmation group with Cancel and explicit Confirm removal buttons.
- **States**: closed, editing, invalid/preserved value, confirmed, confirmation pending, standby/read-only.
- **Tokens**: labelled field, confirmation group, button variants, `--ta-space-2/3`, `--ta-radius-control`.

### `launcher-states` — Launcher states
- **Structure**: fixed focusable `#taa-open-panel` launcher paired with `#taa-panel-overlay`; both roots own the shared token block.
- **States**: default, hover, focus-visible, hostile-host fallback (literal geometry and surface/text/focus values).
- **Tokens**: `--ta-accent`, `--ta-accent-hover`, `--ta-surface-control`, `--ta-text`, `--ta-focus-ring`, `--ta-space-2/4`, `--ta-radius-control`, `--ta-font-system`.

### `alert-hierarchy` — Alert hierarchy
- **Structure**: linked delta-first title (`🚨 Alliance attack`, `🛡️ Alliance raid`, or `🔄 Alliance changes`), singular/plural player count, atomic two-line player blocks, roster one-line blocks, complete current attack/raid totals, then exactly three self-contained fields in order: `New`, `Active now`, `Priority`; world and observation text are one capped footer.
- **States**: normal, high, critical, approximate observation, unavailable observation, split continuation, and one-time mention versus silent continuation.
- **Tokens**: `--ta-status-red*`, `--ta-status-amber*`, `--ta-accent*`, `--ta-text*`, `--ta-space-2/3`, `--ta-font-mono`.
- **Data boundary**: render only observed queue data; do not invent villages, coordinates, arrivals, troops, or reinforcements. The dispatch timestamp is one logical value on the last embed of every request; UTF-16 budgets are 2000/256/4096/1024/6000 with at most 10 embeds. At-least-once delivery remains explicit and may duplicate after uncertain acknowledgement.

### Empty/loading/error/standby banner
- **Structure**: `<aside role="status">` or `<aside role="alert">` with heading and explanatory text; standby includes the next action.
- **States**: empty, loading, error, standby.
- **Tokens**: semantic ramps, `--ta-surface-input`, `--ta-space-3/4`.

### Confirmation action group
- **Structure**: `<fieldset><legend>…</legend><div role="group" aria-label="…">` containing Cancel and Confirm buttons.
- **States**: default, focus, confirm loading, disabled, error requiring retry.
- **Tokens**: button variants, `--ta-space-2`, `--ta-radius-control`.
- **Accessibility**: destructive meaning is explicit in text; focus remains in the group after failure.

## 6. Motion & Interaction

Motion is feedback, not decoration. Micro transitions use `--ta-duration-micro: 120ms` and standard state transitions use `--ta-duration-standard: 220ms`, both `ease-out`; only `transform`, `opacity`, and `filter` may animate. Hover changes affordance, active presses translate by a tokenized `--ta-press-y: 1px`, and focus is immediate and visible. Loading uses a low-key opacity pulse only when it communicates waiting. `@media (prefers-reduced-motion: reduce)` sets durations to `0ms`, removes transforms, and keeps state changes immediate. Forced colors restores system colors with `forced-color-adjust: auto`, `border: 1px solid ButtonText`, and `outline: 2px solid Highlight`.

## 7. Depth & Surface

The strategy is **mixed, restrained**: tonal shifts establish the base hierarchy (`--ta-bg` → `--ta-surface` → `--ta-surface-raised` → `--ta-surface-input`), one subtle border defines interactive boundaries, and one tinted dialog shadow separates the shell from the host page. The extracted dialog shadow was `0 24px 70px rgba(0, 0, 0, 0.5)`; it is preserved as `--ta-shadow-dialog`. Sections retain the extracted `0 4px 12px rgba(0, 0, 0, .18)` as `--ta-shadow-section`, but controls do not receive shadows. No gradients, texture images, remote assets, or ornamental elevation are allowed.

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA: body text >=4.5:1; large text and UI boundaries >=3:1; contrast is computed from rendered token pairs, not eyeballed.
- Every control is native semantic HTML with a visible `:focus-visible` ring using `--ta-focus-ring`; keyboard order follows reading order and the dialog returns focus on close.
- Status is never color-only. Live regions distinguish polite success/loading from assertive errors. Headings, labels, `aria-controls`, `aria-selected`, `aria-invalid`, and `aria-busy` are truthful.
- Reflow works at 375 px and 200% zoom; forced colors and reduced motion have explicit paths; unbroken IDs/URLs wrap.

### Accepted Debt
| Item | Location | Why accepted | Exit |
|---|---|---|---|
| Tampermonkey menu commands remain prompt/alert based | runtime menu commands (`src/runtime.js`) | Explicitly accepted for this release; the panel is the primary workflow | Revisit only with explicit scope |
| Host Travian typography/forced-colors can influence injected context | injected panel root | Existing host page cannot be controlled; root isolation and Chromium evidence mitigate it | Critical/Major finding blocks release |
| Vanilla userscript ships as one generated file | `dist/*.user.js` (built from `src/`) | Required single-file installable constraint | Keep helper seam token-backed and covered by showcase |

## 9. Release 1.0.2 attack-only operations contract

This section is the design contract for the shipped **1.0.2** attack-only userscript. The old `.omo/plans/refine-discord-alert-hierarchy.md` and `.omo/plans/redesign-alliance-news-discord-format.md` are historical input and are superseded; their 5.2.6-era contract is historical, and neither is an independent implementation plan. Previous news data remains inert until you clear site data and no news tab, route, webhook, or storage is active.

### One-tab route and lifecycle topology

Only the query-free `/alliance/profile/members` and `/alliance/profile/members/` routes may acquire authority. A matched noncanonical `/alliance*` route is inert guidance; it cannot scan, commit, enqueue, flush, or reload. Exactly one structural `table.allianceMembers` is required. There is no largest-profile-link fallback. The authoritative tab uses the existing 60–120 second reload lifecycle; standby tabs are read-only. Page readiness uses the complete table plus a 500 ms quiet window; malformed, duplicate-ID, partial, or zero-member tables fail closed and produce no commit. Web-Lock fencing requires the exclusive same-origin lock, lease owner/term, expected monitor generation, and post-write readback to agree before authority mutations. Lease loss fences scan, commit, enqueue, and send; it cannot retroactively mutate committed attack state.
Runtime route roles are `canonical-member`, `alliance-noncanonical`, and `unsupported`. Table rejection reasons are `no-member-table`, `multiple-member-tables`, `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, and `malformed-count`.

### Attack storage, delivery, and bounded state

Attack state is isolated per hostname. Writes use generation-fenced storage; invalid data fails closed. Hard limits are applied per envelope. Queued event snapshots are immutable once enqueued; cache or settings changes never rewrite a queued retry, and delivery never sends a post-delivery correction. Delivery is at-least-once: a lost acknowledgement can produce a duplicate. HTTP 200 with a Discord message ID acknowledges; network/timeout/abort/408/429/5xx are retryable with bounded attempts and capped delay using server-provided `Retry-After` or JSON `retry_after`; ordinary 4xx is retained as failed; malformed or ID-less 200 is uncertain and is not retried automatically. Uncertain records remain manually retryable and do not silently advance state. The retry test proves bounded delay via injected `nowMs`/`sleep` rather than real timers: a 429 with `Retry-After: 1` followed by an ID-bearing 200 uses exactly two attempts and a 1000 ms capped delay. Sampling is net-based: every positive net attack/raid delta visible between accepted snapshots is represented, while arrivals that appear and disappear between samples cannot be inferred.

### Presentation and recovery

The approved Discord hierarchy is the source of truth: titles, player counts, atomic two-line blocks, roster one-liners, totals, three ordered fields, world/observation footer, single logical timestamp on the last embed, `part X/Y` for multi-request output, and one-time mentions with silent continuations. UTF-16 budgets are 2000/256/4096/1024/6000 with at most 10 embeds per request. Diagnostics and exports are bounded and sanitized: they never include webhook tokens, response HTML, or full query URLs, and no webhook token or secret is rendered in DOM values, drafts, or diagnostics. Recovery surfaces pending, failed, and uncertain counts with retry actions and export; lease loss disables mutations immediately.

### Panel lifecycle and accessibility contract

The panel is the existing `Monitor views` tablist with exactly four tabs — `Overview`, `Players`, `Alerts`, `Diagnostics` — and no News tab. Each `tabpanel` contains its native labelled inputs, buttons, feedback, and status. States are default, hover, active/selected, focus, disabled, loading, empty, error, and standby/read-only. The `__TAA_TEST_ALLOW_PANEL__` bypass exists only for loopback harness verification and is not a production affordance. All controls are native labelled elements with visible focus rings and truthful `aria-selected`, `aria-controls`, `aria-invalid`, `aria-busy`, and live status semantics. Validation/storage errors are assertive; successful transitions are polite. Reading-order keyboard navigation, Escape/backdrop/Close focus restoration, 375 px/768 px/1280 px reflow, 200% zoom, reduced motion, forced colors, and unbroken URL wrapping are required. Status is never color-only and the overlay remains the sole scroll owner.

## 10. Module graph (post-extraction reality)

This section pins the executable module graph after the Wave 3 extraction (Todos 7–17, aggregator cutover). It is verified by `test/tools/module-architecture.test.cjs`, `test/characterization/aggregator-cutover.test.cjs`, and `test/tools/readme-runtime-contract.test.cjs`; prose here must agree with those tests, never the reverse.

### 10.1 Domain modules

`src/` holds exactly 13 domain modules. Each domain is a `X.js` facade re-exporting its `X-impl.js` kernel contract by reference (never a copied subset):

| Domain | Facade | Kernel | Contract |
|---|---|---|---|
| `storage` | `src/storage.js` | 12 sub-modules (`storage-impl.js` + `storage-identity/webhook/mappings/provenance/mutes/roster/settings/history/queue/failed/diagnostics`) | 60 symbols |
| `lease` | `src/lease.js` | `src/lease-impl.js` (fencing behind adapters) | 17 symbols |
| `parser` | `src/parser.js` | `src/parser-impl.js` (boundary) | 17 symbols |
| `snapshot` | `src/snapshot.js` | `src/snapshot-impl.js` (presentation) | 15 symbols |
| `envelope` | `src/envelope.js` | `src/envelope-impl.js` (codec) | 27 symbols |
| `migration` | `src/migration.js` | `src/migration-impl.js` (codec) | 12 symbols |
| `discord` | `src/discord.js` | `src/discord-impl.js` (presentation) | 16 symbols |
| `transport` | `src/transport.js` | `src/transport-impl.js` (boundary) | 7 symbols |
| `dispatch` | `src/dispatch.js` | `src/dispatch-impl.js` | 6 symbols |
| `conservation` | `src/conservation.js` | `src/conservation-impl.js` (reference aliases into `envelope-impl`/`migration-impl`, no independent logic) | 7 symbols |
| `diagnostics` | `src/diagnostics.js` | `src/diagnostics-impl.js` (redaction) + legacy tail on the frozen authority | 16 symbols |
| `panel` | `src/panel.js` | `src/panel-impl.js` (session-draft models) + legacy tail on the frozen authority | 22 symbols |
| `acquisition` | `src/acquisition.js` | `src/acquisition-impl.js` (lifecycle owner) | 8 symbols |

Pure modules `constants`/`text`/`route` keep independent implementations verified by `pure-module-parity`. The `src/` dependency graph is acyclic inside the allowed-dependency map in `module-architecture.test.cjs`; only `src/userscript-entry.js` and `src/runtime.js` may name host capabilities.

### 10.2 Aggregator, lifecycle, adapters, authority

- `src/runtime-api.js` is a thin aggregator over the 13 facades: direct re-exports with no `select()` indirection. Every domain object IS the facade module itself (reference-equal), never a copied subset. The legacy `select()` indirection is removed and `runtime-api.js` does not depend on `src/runtime.js`.
- `src/lifecycle.js` is the sole owner of mutable lifecycle state (`createLifecycleController` is its only export; 13 named singletons + 10 timer/listener handles live exactly once here). All other domains receive the controller object and never retain copies of its fields.
- `src/adapters.js` is the seven-factory extraction seam (`createStorageAdapter`, `createClockAdapter`, `createSleepAdapter`, `createGmRequestAdapter`, `createDocumentLocationAdapter`, `createWebLocksAdapter`, `createSessionStorageAdapter`); domain modules never name host globals directly.
- `src/runtime.js` remains the legacy authority: 325 exports pinned by the frozen `runtime-contract.json` oracle, release ID `taa-1.0.2`. Production wiring is unchanged (`src/userscript-entry.js` → `src/runtime.js` → `startBrowserRuntime`); `dist/*.user.js` is generated output, never hand-edited.
