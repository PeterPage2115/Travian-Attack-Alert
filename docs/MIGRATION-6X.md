# Controlled owner transfer: private 6.x → public 1.0.0

Owner-only, optional procedure for moving a fictional 6.2.1 profile to the
public 1.0.0 distributable. External alliances start clean; this path exists
only for an owner who already runs 6.x on their own device and wants to carry
their configuration over.

> [!CAUTION]
> This transfer is NEVER an automatic update.
>
> - Public `1.0.0` is numerically LOWER than private `6.2.1` — no userscript
>   manager will (or must) offer it as an update, and it must never be
>   described as an "update" or "upgrade path".
> - NEVER run the 6.x script and the 1.0.0 script enabled at the same time.
>   Two active senders WILL double-send to Discord; the single-browser lease
>   cannot prevent that across two installations, profiles, or computers.
> - NEVER clear site data during this transfer. Roster, mappings, baselines,
>   and queue state live in site storage; clearing destroys the only
>   recoverable copies.
> - NEVER copy cookies, browser profiles, or credentials anywhere. The only
>   carrier between the two script identities is the settings-backup FILE
>   (or a manually re-typed webhook). GM storage is per-script-identity and
>   is never assumed to be shared.

## Identities

- 6.x: `@namespace travian-alliance-attacks`, release `taa-6.2.1`.
- 1.0.0: `@namespace travian-attack-alert-public`, release `taa-1.0.0`.

They are distinct Tampermonkey scripts with isolated GM storage
(`travianAllianceWebhookUrl_v1` included). `localStorage` site data is shared
per origin and is preserved in place — that is why step 2 disables the old
sender but keeps all site data.

## Owner procedure (in this order)

1. **Export a private backup on the owner's device.** With the 6.x script
   running, use **Export settings** (Diagnostics settings section). Default
   export omits the webhook secret; an explicit opt-in includes it with a
   plain-language warning. Save the file somewhere only the owner can read.
2. **STOP / DISABLE the 6.x script and verify zero sends.** Disable the 6.x
   script in the Tampermonkey dashboard (or disable its `@match` host), then
   confirm no new Discord messages arrive for one full monitor cycle
   (60–120 s). Only proceed when the old sender is provably silent.
3. **Install the 1.0.0 file.** Import `dist/travian-attack-alert.user.js`
   as a NEW Tampermonkey script (Utilities → Import from file). Keep the
   6.x script disabled; do not delete it until step 6 passes.
4. **Import the backup file OR manually re-enter the webhook.**
   - Import path: **Import settings** with the file from step 1. A file
     without a webhook field PRESERVES the stored webhook (absent = preserve,
     never clear). `{action:"clear"}` clears explicitly.
   - Manual path: type the Discord webhook URL via `Set Discord webhook URL`
     and import the default (secret-omitting) file — same result.
   - A failed import rolls back everything (full preimage restore); a
     rejected file (`invalid-fields`) writes nothing.
5. **Verify queue / baseline / config in Diagnostics.** Confirm mappings,
   settings, mutes, names, roster and roles match the 6.x profile; confirm
   the monitor queue carries the in-flight (`ls1:`) records as recoverable
   (never acknowledged), history-only (`lh1:`) records as `unknown-legacy`
   (never acknowledgements), and a removed-by-old-sender record as
   `uncertain-legacy-settlement` (never treated as delivered). Confirm zero
   Discord requests were sent during import/migration.
6. **Enable monitoring.** Only now confirm the single active installation and
   let the first post-migration scan run: identical state sends nothing
   (no historical flood); only genuinely new deltas dispatch.

## Preflight checklist (all must hold before step 6)

- [ ] Old 6.x sender is DISABLED and produced zero sends for a full cycle.
- [ ] Site data was PRESERVED — nothing was cleared, no profile was copied.
- [ ] Exactly ONE active monitoring installation exists for this
      world/alliance (one script, one browser profile, one computer).
- [ ] Transfer carrier was the backup FILE (or manual re-entry) only —
      no assumption of shared GM storage between the two identities.
- [ ] Import result was `imported` (or webhook manually verified), and
      Diagnostics shows the expected config/baseline/queue with zero
      unexpected Discord traffic.

If any box cannot be checked — especially if BOTH scripts are (or may be)
enabled — STOP. Resolve to a single sender before continuing. The migration
test harness encodes this as a loud `double-sender-enabled` preflight
failure; the runtime itself stays single-sender by lease design and offers
no cross-installation protection.

## Rollback

1. Disable the 1.0.0 script in the Tampermonkey dashboard.
2. Re-enable (or re-import) the prior 6.x `.user.js` file.
3. Keep all site data untouched — do not clear storage.
4. Reload the canonical route (`/alliance/profile/members`, no query) and
   verify the 6.x monitor resumes as owner with its queue intact.

## Verification (offline, fixtures only)

- `node --test test/artifact/migration-6x.test.cjs` — legacy `ls1:` /
  `lh1:` handling, legacy string webhook, absent-secret preserve, malformed
  zero-write + full rollback, one-shot migration marker.
- `npx playwright test test/e2e/migration-6x.spec.ts --config
  test/e2e/playwright.config.ts` — browser import-flow with seeded fictional
  6.x storage (webhook preserved from manual re-entry, all other fields
  merged, first scan sends only new deltas) plus the no-double-sender guard.
- `npm run check:release -- --offline` — full gate, honest record.

All fixtures are synthetic (example hostnames, `FAKE` webhook tokens,
loopback only). No real hosts, webhooks, or network are ever used.
