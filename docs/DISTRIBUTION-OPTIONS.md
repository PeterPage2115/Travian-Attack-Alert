# Distribution options — sourced decision record (no migration)

Status: **decision record only — no distribution change is performed or authorized by this page.** Recorded 2026-09-24 against identity `1.0.1` / `taa-1.0.1` (`package.json`). This page generates no extension manifest, extension code, PWA code, dependency, storage migration, or release channel. It compares four shells for the existing runtime, cites the constraints to primary sources, marks the policy questions unresolved, and recommends keeping the tested Tampermonkey userscript as the current release artifact.

Superseded historical drafts are not authorization: `.omo/drafts/attackalert-productization.md` and `.omo/drafts/privacy-first-travian-product.md` are **unapproved planning inputs** (both carry `status: awaiting-approval`). They are outside the Git checkout and may be absent; nothing in this record depends on them being present.

## 1. Decision

- **Retain the tested userscript as the current release artifact.** The shipped `dist/travian-attack-alert.user.js` remains the only released shell; the update channel stays `release/public-1.0.0` via `@updateURL`/`@downloadURL` (`config/userscript.json:23-24`).
- **An MV3 feasibility program is optional and later, owner-approved, and only if store-install reach or isolated permissions/browser-native ergonomics demonstrably warrant it** (revisit conditions in §7). Feasibility is not approval.
- **A desktop companion is a separate product**, not an alternative shell for this artifact, and **a PWA is a complement, not a replacement** — it cannot observe the Travian page DOM (§4).
- No shell in this record is "already approved"; no owner or platform confirmation exists yet (§6).

## 2. Evidence base

Primary sources, all fetched 2026-09-24 (raw snapshots in the task evidence, `task-35/sources/`; the Travian game-rules page is client-rendered, so a Chromium-rendered text snapshot is stored alongside the raw shell):

- **[S1]** Chrome extension service-worker lifecycle — `https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`
- **[S2]** Chrome cross-origin network requests — `https://developer.chrome.com/docs/extensions/develop/concepts/network-requests`
- **[S3]** Tampermonkey documentation (API index) — `https://www.tampermonkey.net/documentation.php`
- **[S4]** MDN "Offline and background operation" (PWA guide) — `https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation`
- **[S5]** Travian: Legends International Game Rules, §3 "Use of external programs" — `https://www.travian.com/international/gameRules`
- **[S6]** Travian support article 122, "How can I remove a bot / script from my browser?" — `https://support.travian.com/en/articles/122-how-can-i-remove-a-bot-script-from-my-browser`

Local product facts cited by path:line:

- Manifest config: name/namespace, `@match https://*.travian.com/alliance*`, five grants, `@connect discord.com`, `run-at document-idle`, `noframes`, both update URLs — `config/userscript.json:5-24`.
- Entry and production wiring: `src/userscript-entry.js:9-13` requires `src/runtime.js` and starts the browser runtime when `document`/`location` exist; the adapter seam is present but dormant — `src/adapters.js:3-11`, `docs/architecture.md:232-237`.
- Operations contract: canonical query-free `/alliance/profile/members`, one authoritative tab, 60–120 s reload lifecycle, at-least-once delivery, bounded redacted exports — `docs/architecture.md:185-204`.
- Storage layout: webhook in manager (GM) storage under `travianAllianceWebhookUrl_v1` (`src/runtime.js:1155-1194`); per-world monitor envelope under the `travianAllianceMonitor_v1:` prefix (`src/constants.js:19-21`, `src/runtime.js:4444-4468`); page-origin `localStorage` keys for mappings/settings/roster/queues (`src/storage-impl.js:64-75`) and the tab lease `travianAllianceTabLease_v1` (`src/runtime.js:241`, `src/runtime.js:2464`).
- Manager menu surface: 26 `GM_registerMenuCommand` registration call sites in `src/runtime.js` (first at `:9999`, last at `:10474`); the panel is the four-tab `Monitor views` surface (`docs/architecture.md:204`).

Unapproved planning inputs (attributed as claims, never as evidence or authorization):

- `.omo/drafts/attackalert-productization.md` — proposes an MV3 consumer shell to remove the Tampermonkey onboarding wall and a Tauri companion that supervises the user's own browser session via native messaging; it also flags the Chrome 138+ `Allow User Scripts` friction. **Unapproved**: the file itself is `awaiting-approval`, and the native-messaging mechanism is out of scope for this record. Only the framing (store-install friction; companion is separate) is reused here, and the friction fact is independently documented in the README's install section.
- `.omo/drafts/privacy-first-travian-product.md` — proposes a self-hosted/desktop topology where the user owns the browser session, the machine, and the webhook, and the vendor never hosts or relays game sessions. **Unapproved**: `awaiting-approval`; only the user-owned session/webhook boundary is reflected here, and the "desktop companion is separate" statement is this record's own conclusion.

## 3. Option matrix

Each cell states the constraint that matters; source tags point at §2. "Current" = the shipped userscript.

| Dimension | Userscript (current) | MV3 content-script + service-worker extension | Standalone PWA | Desktop companion |
|---|---|---|---|---|
| Third-party DOM reach | Direct: runs in the Travian page under the manager sandbox on the matched route (`config/userscript.json:5-18`), reads the canonical members table (`docs/architecture.md:191`). | A content script in a matched tab can read the same DOM; the background service worker cannot see page DOM by itself and is terminated when idle **[S1]**. | None for third-party pages: a service worker controls only its own app's pages **[S4]**; it cannot observe the Travian tab DOM. | None by itself: no page DOM without an in-browser bridge (e.g. a companion extension/native messaging); separate product scope. |
| Installation friction | Manager install plus, on Chrome 138+ with Tampermonkey 5.3+, the browser's `Allow User Scripts` toggle; with it off nothing executes (README "Install and update"). | One store install, but adds store submission/review and install-time permission prompts; distribution depends on store policy. | Requires a product origin to install from; no such origin exists today. | OS installer/updater and signing; independent of browser install. |
| Cross-browser reach | Manager-dependent. Tested combination: desktop Chrome + Tampermonkey; Firefox + Tampermonkey and Violentmonkey are candidate-only until proven (README "Status and limitations"). | Chrome-family manifest; other engines have their own MV3 differences that need separate verification — **UNRESOLVED**. | Browser-generic where installed, but own-origin only. | OS-specific packaging; browser-independent. |
| Update/distribution | Manager polls `@updateURL`/`@downloadURL` pointing at the release-branch raw dist (`config/userscript.json:23-24`); one generated file, no store. | Store review and versioned packages per store; a second artifact/release contract. | Service-worker update from its own origin plus hosting. | Adds vendor updater/installer maintenance as a separate product surface. |
| Browser/OS notifications | Only user-visible channel today is the user-owned Discord webhook. `GM_notification` exists in the manager API index **[S3]** but is **not granted** (`config/userscript.json:8-14`), and the runtime contains no notification call. OS notifications therefore do **not** require an extension. | Can use browser notification APIs, but that is an additional permission surface, not the current channel. | Notifications/push exist but require user permission and must be user-visible **[S4]**; own origin only. | Native OS notifications available to a native app; separate product. |
| Tab/browser-off availability | Only while a tab on the canonical route is open; 60–120 s reload lifecycle; no 24/7 (`docs/architecture.md:191`; README "Status and limitations"). | Content script only while a tab is open; the service worker is ephemeral — Chrome normally terminates it after ~30 s idle, with single-event bounds (5 min request / 30 s fetch) and explicit "design to be resilient against unexpected termination" **[S1]**. | Only while the app/worker is running; browsers may stop workers at their discretion **[S4]**. | Can run independently of the browser, but cannot read the third-party DOM on its own. |
| Security/permission surface | Five grants (`GM_xmlhttpRequest`, `GM_registerMenuCommand`, `GM_getValue`, `GM_setValue`, `GM_deleteValue`) plus `@connect discord.com` (`config/userscript.json:8-17`). | Needs `host_permissions` for the Travian hosts and Discord; extension-origin requests may cross origins **only with host permissions** **[S2]**, and content-script requests stay CORS-treated even then **[S2]**; adds store supply chain. | No third-party host permissions; own-origin only. | OS-level privileges plus installer/updater supply chain. |
| Storage migration | Current locations: webhook in GM storage; monitor envelope in GM storage per world; mappings/settings/roster/queues and the tab lease in the page origin's `localStorage` (§2). | **The GM secret cannot be read by an extension** — different storage origin; the webhook must be re-entered or migrated by explicit user action. Page-origin `localStorage` is not extension storage; each key needs an explicit mapping. | Cannot read GM storage or the Travian origin's `localStorage`; fresh store on its own origin. | No browser storage access; would need a new local store. |
| Release maintenance | Deterministic build to `dist/` plus sidecar/metadata/module-manifest, verified by `npm run check:artifact`; single channel. | Adds manifest, per-store packaging, review cycles, and a parallel artifact contract to keep byte-honest. | Adds hosting, an origin, and service-worker cache/update maintenance. | Adds installers, signing, and updater maintenance. |
| User-data exposure | No backend; webhook and product data stay in browser/manager storage; exports are bounded and redacted (README "Privacy"). | Same data model if ported; store sees code, not user data; still no server needed. | Implies a hosted product origin; must be designed never to receive payloads. | Adds a separate app and update channel; must not become a relay. |
| User-owned webhook handling | Webhook is supplied and held by the user in manager storage; delivery is a direct manager request to Discord (`src/runtime.js:7149`; `src/transport-impl.js:69-70`). | Must keep the webhook user-owned in extension storage; no hosted relay. A relay would see player names/IDs, world, counts, and the webhook — explicitly out of scope for every option. | Same rule: the webhook stays user-supplied in own-origin storage; no relay. | Same rule: the webhook stays user-supplied in a local store; no relay. |
| Manager-specific menu → popup/options migration | Setup/recovery lives in the manager menu (26 registrations, §2) with prompt/alert dialogs (`docs/architecture.md:181`). | Every command and confirmation flow must be re-implemented as an action popup and/or options page; the panel already carries daily work (`docs/architecture.md:204`). | No manager menu; would need in-app settings/recovery UI. | CLI/dashboard equivalent; separate product. |

## 4. Constraints that no shell removes

- **No 24/7 and no exactly-once guarantee.** The runtime documents at-least-once delivery (`docs/architecture.md:196`) and the README states there is no 24/7 guarantee; MV3 does not change this: its worker is ephemeral **[S1]**, and a PWA worker may be stopped at browser discretion **[S4]**. A second sender still double-sends.
- **Service workers are not always on.** Chrome "terminates a service worker" after ~30 s of inactivity and bounds single events at 5 minutes (requests) and 30 s (`fetch()` responses) **[S1]**; MDN: "This doesn't mean service workers run all the time" **[S4]**. Any MV3 design must persist state and re-arm on events rather than assume residency.
- **A PWA cannot observe the Travian tab DOM.** Its service worker controls only its own app's pages **[S4]**; there is no cross-origin DOM access.
- **OS notifications do not require an extension.** `GM_notification` exists in the manager API index **[S3]** (currently ungranted here), and the PWA guide lists the Notifications API among its technologies **[S4]**; a native desktop app has native notifications.
- **No reliance on permissive or undocumented Discord CORS.** The current artifact sends through the manager request capability (`GM_xmlhttpRequest`, `config/userscript.json:9`), not page `fetch()`. An extension background request needs `host_permissions` **[S2]**; "empirically it worked" is not a contract.
- **The manager secret does not migrate by itself.** GM storage is not readable by an extension, and page-origin `localStorage` is not extension storage (§3, "Storage migration"). Any port needs an explicit, user-visible mapping.

## 5. Migration ledger — if a port were ever approved (not executed here)

| State today | Current home | MV3 mapping (would be needed) | PWA mapping | Desktop mapping |
|---|---|---|---|---|
| Discord webhook secret `travianAllianceWebhookUrl_v1` | GM storage (`src/runtime.js:1155-1194`) | Re-entry or explicit user-approved import into extension storage; **never** read from GM storage | Re-entry into own-origin storage | Re-entry into local store |
| Monitor envelope `travianAllianceMonitor_v1:<world>` | GM storage (`src/constants.js:19-21`) | Key-by-key copy through a user-invoked export/import; world key shape preserved | Same, own origin | Same, local store |
| Mappings/settings/roster/queues (`travianAlliance*_v1`) | Travian-origin `localStorage` (`src/storage-impl.js:64-75`) | Explicit per-key mapping; origin differs | Not readable; re-import only | Not readable; re-import only |
| Tab lease `travianAllianceTabLease_v1` | Travian-origin `localStorage` (`src/runtime.js:241`, `:2464`) | New fencing primitive with equivalent owner/term/readback semantics | Equivalent, own origin | Equivalent, local store |
| Manager menu commands (26 registrations) | `GM_registerMenuCommand` (`src/runtime.js:9999-10474`) | Action popup/options page with equivalent setup/recovery flows | In-app settings/recovery UI | CLI/dashboard |
| Update channel | `@updateURL`/`@downloadURL` raw dist (`config/userscript.json:23-24`) | Per-store update policy | Own-origin service-worker update | Vendor updater |

This ledger is a mapping requirement list, not a plan: nothing here was executed, and no storage key, grant, or artifact was touched by this task.

## 6. Policy status — UNRESOLVED

The game-platform policy question is **unresolved** and must not be asserted either way. The primary sources are explicit that the mechanism is at least in scope of prohibitions:

- Travian: Legends Game Rules §3: "Travian: Legends must be played using a conventional and unmodified browser. The use of scripts and/or bots to automate actions on the avatar or to resemble premium features is forbidden." The non-exhaustive list includes "Scanning the statistics of other players automatically" and "Any other automated actions performed by third-party software", and the rules reserve the right to penalize script/bot use **[S5]**.
- Support article 122: "Any browser extension or add-on that alters the game's appearance or behavior is prohibited and should be removed completely … Even an extension or script that refreshes your page regularly should be deleted. Any third-party tool that interacts with the game is prohibited, including tools used only to view statistics, monitor alliance activity, or coordinate an alliance." **[S6]**

Consequences recorded here: no shell in this matrix is declared compliant, authorized, or low-risk; **explicit written owner and platform confirmation is required before any distribution change**, and this record must not be used as evidence of permission. The existing userscript's release state (`docs/release-state.json`, `stable: true`) and the pilot gate remain in force.

## 7. Recommendation and revisit conditions

Retain the userscript (current release artifact) because it is the tested, byte-verified channel and every alternative adds a permission surface or a hosting/installer surface without removing the constraints in §4. Reopen the MV3 option only if **all** of the following are demonstrated, not assumed:

1. A store-install path or isolated-permission model is shown to materially reduce install friction for real users (measured, not asserted).
2. A concrete storage-migration design for the GM secret and page-origin state exists with explicit user consent (no silent reads).
3. Browser-native ergonomics (notifications, background recovery) are shown to beat the Discord-only channel without claiming 24/7 or exactly-once.
4. The policy question in §6 is resolved by written owner and platform confirmation.
5. The port preserves the operational contract (`docs/architecture.md:185-204`) and keeps the release gates green with no unapproved grant.

A desktop companion is evaluated separately if ever pursued; a PWA remains a complement for documentation/onboarding, never a DOM-observing replacement.

## 8. Non-actions in this record

- No extension manifest or extension code; no PWA code; no new dependency (`package.json` `dependencies` stays absent/empty).
- No change to `src/`, `config/`, grants, storage keys, generated artifacts, update URLs, owner-gate values, or `docs/release-history/`.
- No storage migration, no webhook re-entry, no channel switch, no store submission, no publication.

## 9. See also

- [`architecture.md`](architecture.md) — runtime and operations contract (§9) and module graph (§10).
- [`RELEASE-RUNBOOK.md`](RELEASE-RUNBOOK.md) — the ordered, owner-gated release procedure.
- [`release-state.json`](release-state.json) — machine-readable owner gates (`stable: true`).
- [`../README.md`](../README.md) — the current install/update path and honest pilot status.
- [`../CHANGELOG.md`](../CHANGELOG.md) — release history entries.
