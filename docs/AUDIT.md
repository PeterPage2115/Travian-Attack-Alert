# Audit 1.0.0 — detector behavior matrix (plan Todo 7)

Date: 2026-09-13 · Branch: `release/public-1.0.0` · Release: `taa-1.0.0`
Runtime authority: `dist/travian-attack-alert.user.js` (byte-identical to `script.txt`, SHA `78f86665…44084` per inherited tree state; re-verified by the matrix test itself).
Matrix: `test/artifact/detector-matrix.test.cjs` — 17 tests, all green on unchanged code.

Verdict: **no CONFIRMED bugs. No `script.txt` change was made.** Every row below
is either a locked behavior (proof: passing matrix test) or a documented
LIMITATION (constraint, not a bug — deliberately not "fixed" to avoid changing
semantics). TDD red-phase was not reachable because no failing proof exists;
inventing fixes is explicitly out of scope for this task.

## Blocker

| finding | area (file:function:lines) | evidence (test/fixture/command) | verdict |
|---|---|---|---|
| _(none)_ | — | `node --test test/artifact/detector-matrix.test.cjs` → 17 pass / 0 fail on unchanged code | No blocker found; matrix is the proof. |

## Important

| finding | area (file:function:lines) | evidence (test/fixture/command) | verdict |
|---|---|---|---|
| Rejected scans must never move the authoritative baseline | `script.txt:planAcceptedScanTransition:5265` + `commitMonitorEnvelope:5337` | matrix test "every rejected scan leaves the authoritative baseline byte-identical": 4 rejected/partial shapes → `invalid-snapshot` → `invalid-transition`, `memorySwapped:false`, storage bytes + active envelope bytes identical before/after | LOCKED (no fix needed) |
| Counter drop must never fabricate a negative alert | `script.txt:diffAllianceSnapshots:4150-4195` (`Math.max(0, …)`), `diffAttackStates:7062-7106`, `planAcceptedScanTransition:5306-5307` | matrix tests "counter drop emits NOTHING" + "planner drops counters": 5→2 / 3→1 and 4→1 / 2→0 give `[]`, baseline still advances to observed counts | LOCKED (no fix needed) |
| Per-hostname baseline isolation | `script.txt:monitorActiveStorageKey` (`travianAllianceMonitor_v1:<host>`), `commitMonitorEnvelopeV1:5386` | matrix test "two world hostnames keep isolated baselines": commit for `s1.example.travian.com` leaves `s2.example.travian.com` envelope at generation 0 with empty baseline | LOCKED (no fix needed) |
| Queue bound overflow is reported, never silently dropped | `script.txt:enqueueEvents:2090-2126` (`QUEUE_MAX_EVENTS=50`, `overflowCount`/`overflowReason:"queue-cap"`) | matrix test "single accepted scan over the queue bound": 60 events → 50 kept (newest), `overflowCount:10`, message matches /bounded/i | LOCKED (no fix needed) |
| Exact table-rejection reason codes | `script.txt:selectMemberTable:5593-5611`, `extractAllianceSnapshotFromDocument:5639-5709` (+ row level `extractAllianceSnapshotFromRows:4080-4142`) | matrix tests "exact documented reason codes" (all 7: `no-member-table`, `multiple-member-tables`, `pagination-or-filter`, `missing-player-id`, `duplicate-player-id`, `conflicting-tooltip`, `malformed-count`) + "row-level duplicate/partial/empty fail closed" | LOCKED (no fix needed) |

## Cosmetic

| finding | area (file:function:lines) | evidence (test/fixture/command) | verdict |
|---|---|---|---|
| Unparseable zero-count icon (`no attacks`) fails closed as `malformed-count` instead of establishing 0/0 | `script.txt:parseNormalizedMemberRow` via `extractAllianceSnapshotFromRows:4080` | probe: `buildAllianceSnapshot` with `icon('no attacks')` → `status:invalid`, `malformedCount:true`; locked in matrix test "zero attacks" | LOCKED, fail-closed is correct — no change |
| `diffAllianceSnapshots` legacy `commit:true` on disappear (empty current) while emitting no events | `script.txt:diffAllianceSnapshots:4189-4194` | matrix test "disappear emits no phantom attack": `events:[]`, `current:{}` | LOCKED — disappearance itself is not an alert; roster `leave` is the signal |

## Deferred (documented LIMITATIONS — constraints, not bugs; no semantic change)

| finding | area (file:function:lines) | evidence (test/fixture/command) | verdict |
|---|---|---|---|
| L-01 Reappear-after-absence surfaces the visible count as a positive net delta at planner level (baseline drops absent members, so reappearance has no previous counts) | `script.txt:planAcceptedScanTransition:5277-5308` (`baselineByPlayerId` built from current members only), `diffAttackStates:7062-7106` (same netting) | probe: disappear commits baseline `{}` → reappear with 3 attacks yields 1 detection `addedAttackCount:3`; roster `diffRoster:1404` still reports `join` independently; locked in matrix test "reappear-after-absence … (AUDIT L-01)" | LIMITATION per DESIGN §9 net-based sampling ("every positive net attack/raid delta visible between accepted snapshots is represented"); roster join+leave stays the membership signal. Suppressing it would create misses — forbidden. No fix. |
| L-02 Sampling gaps: arrivals that appear and disappear between two accepted snapshots cannot be inferred | DESIGN §9; `script.txt` 60–120 s reload lifecycle | by design, quoted in DESIGN §9 | LIMITATION, no fix |
| L-03 At-least-once delivery may duplicate after a lost acknowledgement | DESIGN §9; dispatch/transport queue stages | by design, covered by Todos 10+ delivery matrix, not this task | LIMITATION, no fix |
| L-04 First-scan-with-preexisting-counts onboarding semantics (clean install, no historical flood) | `script.txt:runAttackLifecycleForDocument:7185-7274` | owned by Todo 9 e2e (`clean-install.spec.ts`); this matrix deliberately uses all-zero establishment scans to avoid trespassing that task's scenarios | DEFERRED to Todo 9, no fix here |
| L-05 Uncertain settlement stays manual (`uncertain` never auto-retries to success) | DESIGN §9; `script.txt:classifyDiscordResponse:2804`, `sendDiscordPayloadWithRetry:2866`, `settleMonitorTransport:7668` | Todo 10 delivery matrix, all green on unchanged code: artifact test "(e) ID-less and non-JSON 200" (exactly 1 wire request, `attempts:1`, `uncertain`, `malformed-json-200` parked, `failed` empty) + queue test "(d)/(e)" (`failed` vs `uncertain` retention) + e2e `discord-delivery.spec.ts` (3/3: retry-then-ack, restart-lineage, no-ping) | PROVEN-CORRECT (Todo 10): no auto-retry from `uncertain`; manual `Retry uncertain` / `Mark delivered` menu path unchanged. No fix. |

## Verification

- `node --test test/artifact/detector-matrix.test.cjs` → 17 pass / 0 fail.
- `npm run check:release -- --offline` → overall PASS: 11 gates PASS
  (incl. new `artifact-matrix`), e2e NOT_EXECUTED with reason (port
  127.0.0.1:8899 held by a foreign server answering
  `{"ok":true,"panelState":null}` on `/health`; zero suites ran in every
  per-spec report). The runner classifies total-non-execution via bind
  conflict as NOT_EXECUTED (`e2EBlockedByOccupiedPort` in
  `tools/check-release.cjs`); any executed spec failure still yields FAIL.
  Rerun e2e where 8899 is free.

## Method

- Tests execute `require(dist/travian-attack-alert.user.js)`; the first matrix
  test proves dist bytes === `script.txt` bytes, sidecar SHA matches, version
  header + `RELEASE_ID` are 1.0.0/`taa-1.0.0`, and export sets are identical —
  so "dist or the identical runtime authority" holds either way.
- Fixtures are synthetic only (`101`/`102`/`103`, `s1`/`s2.example.travian.com`);
  no DEV backup bytes, no real hosts, no network.
- Rejected-scan byte-identity is proved through the REAL guards
  (`planAcceptedScanTransition` → `invalid-snapshot`,
  `commitMonitorEnvelope` → `invalid-transition`, `memorySwapped:false`), not
  through a mock — storage bytes and the serialized active envelope are
  compared before/after.
- `script.txt` was not edited, so no `npm run backup` was required (backup is
  mandated BEFORE any `script.txt` edit; there was none).
