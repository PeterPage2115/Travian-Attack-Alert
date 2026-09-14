'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'src', 'runtime.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');
const runtime = require(path.join(ROOT, 'src', 'runtime.js'));

const API_NAMES = `
BATCH_FLUSH_MS
DEBUG_VERBOSE_STORAGE_KEY
DIAGNOSTICS_LIMITS
DIAGNOSTICS_SCHEMA_VERSION
DIAGNOSTICS_STORAGE_KEY
DISCORD_CONTENT_LIMIT
DISCORD_EMBEDS_LIMIT
DISPATCH_CHUNK_STATES
DRAIN_MAX_WAIT_MS
DRAIN_POLL_MS
EMBED_DESCRIPTION_LIMIT
EMBED_DESCRIPTION_SAFE_BUDGET
EMBED_FIELD_VALUE_LIMIT
EMBED_TOTAL_SAFE_BUDGET
EMBED_TOTAL_TEXT_LIMIT
EVENT_NAME_MAX
EVENT_URL_MAX
FAILED_BATCH_STORAGE_KEY
FAILED_QUEUE_MAX_EVENTS
HISTORY_MAX_EVENTS
HISTORY_STORAGE_KEY
LEGACY_CANONICAL_EVENT_FIELDS
MAX_ATTEMPT_COUNT
MAX_RETRY_DELAY_MS
MEMBER_TABLE_REASON_CODES
MONITOR_ACTIVE_STORAGE_KEY_PREFIX
MONITOR_BACKUP_STORAGE_KEY_PREFIX
MONITOR_ENVELOPE_SCHEMA_VERSION
MONITOR_MAX_PENDING_RECORDS
MONITOR_QUARANTINE_MAX_BYTES
MONITOR_QUARANTINE_MAX_ENTRIES
MONITOR_QUARANTINE_STORAGE_KEY_PREFIX
NAME_BACKFILL_MAX_CONCURRENCY
NAME_BACKFILL_TIMEOUT_MS
NAME_NOT_FOUND_TTL_MS
PANEL_BACKFILL_ORPHAN_CAP
PAYLOAD_CHUNK_MAX
PENDING_BATCH_STORAGE_KEY
PLAYER_NAMES_NOT_FOUND_KEY
PLAYER_NAMES_STORAGE_KEY
PRIORITY_COLORS
QUEUE_MAX_EVENTS
RELOAD_REFUSAL_REASONS
REQUEST_TIMEOUT_MS
RETRY_DELAY_MS
ROSTER_STORAGE_KEY
ROUTE_ROLES
SCAN_COMMIT_ERROR_REASONS
SCAN_CYCLE_DEADLINE_MS
SCAN_CYCLE_QUIET_MS
SETTINGS_BACKUP_DATA_KEYS
SETTINGS_STORAGE_KEY
STARTUP_ACQUIRE_JITTER_MAX_MS
STARTUP_ACQUIRE_JITTER_MIN_MS
TAB_LEASE_RENEW_MS
TAB_LEASE_RETRY_MS
TAB_LEASE_STORAGE_KEY
TAB_LEASE_TTL_MS
WEBHOOK_STORAGE_KEY
ackHashForDiscordMessageId
acquireLease
addInFlightChunk
addMapping
addMutedPlayer
addPlayerNamesBatch
aggregateHistory
appendDiagnosticRecordV2
appendDiagnosticTraceV2
applyDispatchPlanTransitionV1
applyEventThresholds
applyMonitorQueueTransitionV1
applyPanelLeaseState
applySettingsBackup
batchPriorityColor
boundedDiagnosticRecords
buildAllianceSnapshot
buildAllowedMentions
buildCompactDiscordPlayerLine
buildCompactDiscordPresentation
buildCompactDiscordSummaryFields
buildCompactDiscordTiming
buildCompactDiscordTitle
buildCountReconciliationPanelModel
buildDiagnosticsPanelModel
buildDiscordPayloads
buildDiscordRequestUrl
buildDispatchPlanV1
buildDispatchRequestV1
buildEventDescriptionLine
buildHistoryPanelRows
buildHistoryRecord
buildIdToName
buildIncidentBundle
buildMappingKey
buildMentionContent
buildNotFoundIdSet
buildOperationalStateLines
buildPlayerWorkspaceModel
buildPlayerWorkspaceReadModel
buildProfileLink
buildRosterMap
buildScanSummaryLog
buildSettingsBackup
buildStableTableSignature
buildStatsPanelModel
buildStatusPanelModel
buildStorageProvenanceModel
canonicalLegacyEventFields
canonicalSerializeDiagnosticValue
canonicalSerializeDiagnostics
canonicalSerializeMonitorValue
canonicalizeLegacyActiveEvent
canonicalizeLegacyHistoryRecord
checkLifecycleFence
checkTooltipSourceAgreement
checksumMonitorCanonicalValue
chunkEvents
chunkEventsForDiscord
classifyAllianceRoute
classifyDiscordResponse
classifyEvent
classifyLease
classifyPriority
classifyReloadRefusal
clearAlertRoleId
clearBatchEvents
clearFailedEvents
clearLeaveRoleId
clearWebhookUrl
coalesceMonitorPendingEvents
collectUnknownIds
commitDispatchPlanTransitionV1
commitMonitorEnvelope
commitMonitorEnvelopeV1
commitMonitorQueueTransitionV1
compactDeliveryAccountingV1
compareMonitorGenerations
computeQueueAge
computeUnmappedPlayers
countFailedEvents
createAdminDraftState
createDiagnosticWorldV2
createDiagnosticsWorldV2
createDispatchPlanInAccountingV1
createDocumentScanState
createLeaseToken
createMonitorEnvelopeV1
createMonitorQueueEvent
createNameBackfillPlan
createScanCycleId
createTabOwnerId
createVisibilityDriftTracker
decideScanCycleOutcome
decodeLegacyIdentity
decodeSourceEventId
describeAlertRoleError
describeAlertThresholdError
describeFreshnessState
describePlayerFilterState
describeScanTerminal
diagnosticByteLength
diffAllianceSnapshots
diffAttackStates
diffRoster
dropInFlightHead
encodeMarkdownUrl
encodeSourceTuple
enqueueEvents
enqueueFailedEvents
extractAllianceSnapshotFromDocument
extractAllianceSnapshotFromRows
extractMembersFromTable
extractNameFromProfileHtml
extractPlayerId
filterMutedEvents
formatPlayerPaginationStatus
formatTraceCountStatus
gateAdminDraftReload
getDefaultSettings
getFailedEvents
getInFlightChunks
getOrCreateTabOwnerId
getStartupAcquisitionJitterMs
getStoredAttackCount
getStoredCount
getStoredRaidCount
hasExclusiveWebLocks
highestBatchPriority
inspectDiscordConfigStorage
inspectMappingStorage
inspectSettingsBackup
isAdminDraftEmpty
isAlliancePageReady
isAttackIcon
isLeaseActive
isLeaseFenceValid
isLifecycleFenceValid
isMonitorGenerationFenced
isPanelAsyncResultCurrent
isPlayerMuted
isReadinessReady
isRetryableOutcome
isScanCycleReady
isScanTerminalRecord
isValidDiscordTime
listMappings
listMutedPlayers
loadDiagnostics
loadDiagnosticsV2
loadDiscordConfig
loadDiscordConfigProvenance
loadFailedBatch
loadHistory
loadLease
loadLeaseRecord
loadMappings
loadMappingsProvenance
loadMonitorEnvelopeV1
loadMutedPlayers
loadOrMigrateMonitorEnvelopeV1
loadPendingBatch
loadPlayerNames
loadPlayerNamesNotFound
loadRoster
loadSettings
loadWebhookUrl
lockNameForHostname
markDocumentScanAttempted
markPlayerNamesNotFound
maskWebhookUrl
measureDiscordEmbedText
migrateLegacyMonitorStateV1
migrationFriendlyCountRecords
monitorActiveStorageKey
monitorBackupStorageKey
monitorQuarantineStorageKey
monitorStorageAdapter
monotonicDurationMs
normalizeProfileInput
paginatePlayerWorkspaceRows
parseAttackCount
parseLease
parseMemberSnapshot
parseMonitorEnvelopeV1
parseNormalizedMemberIcon
parseNormalizedMemberRow
parseRaidCount
parseRetryAfterMs
partitionCompactDiscordEntries
patchPlayerNameNodes
persistAdminDraft
planAcceptedScanTransition
planMonitorLegacyMigration
prepareTerminalCompactionV1
priorityLabel
quarantineMonitorRawV1
raidWord
readSessionStorageSafely
recordDiagnosticTraceV2
recordDuration
recordFailure
recordHistory
releaseLease
removeMapping
removeMutedPlayer
renewLease
replaceInFlightHeadAttempt
requeueFailedEvents
resetDocumentScanState
resolveEventPriority
resolvePanelExit
restoreAdminDraft
resumeTerminalCompactionV1
runAttackLifecycleForDocument
runNameBackfill
safeAllianceUrl
safeProfileUrl
sanitizeDiagnosticText
sanitizeDiagnosticsExport
sanitizeRetryDelay
saveDiagnostics
saveDiagnosticsV2
saveDiscordConfig
saveFailedBatch
saveHistory
saveLease
saveMappings
saveMutedPlayers
savePendingBatch
savePlayerNames
savePlayerNamesNotFound
saveRoster
saveSettings
saveWebhookUrl
selectAuthoritativeMemberTable
selectLatestScanTerminalRecord
selectMemberTable
selectMentions
selectScanTerminalRecord
sendDiscordPayload
sendDiscordPayloadWithRetry
serializeDiagnosticConsoleV2
serializeDiagnosticExportV2
serializeDiagnosticsConsoleV2
serializeDiagnosticsExportV2
serializeMonitorEnvelopeV1
setAlertRoleId
setLeaveRoleId
shouldAttemptDocumentScan
shouldKeepWaitingForDrain
shouldRebaseline
snapshotBatch
sourceEventIdFromTuple
sourceEventTuple
startBrowserRuntime
storageProvenanceText
supportsInputSelection
toPendingEvent
truncateText
updateVisibilityDriftTracker
validateDiscordRoleId
validateDiscordUserId
validateSettings
validateWebhookUrl
writeVerifiedJson
`.trim().split('\n');

const BOOT_EFFECTS = [
  ['classify-initial-route', 'const initialRoute = classifyAllianceRoute(location.href);'],
  ['gate-authority-to-canonical-route-with-web-locks', 'initialRoute.role === ROUTE_ROLES.CANONICAL_MEMBER && hasExclusiveWebLocks()'],
  ['show-standby-and-initialize-panel-without-authority', 'setStandbyVisibility(true);\n      initAdminPanel();\n      return;'],
  ['track-visibility-drift', 'document.addEventListener("visibilitychange"'],
  ['delay-lock-acquisition-with-random-jitter', '}, getStartupAcquisitionJitterMs(Math.random()));'],
  ['request-host-scoped-exclusive-web-lock', 'navigator.locks.request(\n        lockNameForHostname(worldHostname),\n        { mode: "exclusive" }'],
  ['acquire-persistent-tab-lease', 'const leaseResult = acquireLease('],
  ['keep-follower-read-only-and-watch-for-takeover', 'startFollowerWatchdog(worldHostname, tabOwnerId, false);'],
  ['renew-leader-lease-and-release-on-unload', 'startLeaseRenewal(worldHostname, tabOwnerId);'],
  ['register-leader-menu-commands', 'GM_registerMenuCommand(\n            "Open alert monitor panel"'],
  ['log-startup-version', '"[Alliance Discord] Script " + startupVersion + " started."'],
  ['initialize-admin-panel', 'initAdminPanel();'],
  ['flush-pending-batch', 'flushPendingBatch();'],
  ['install-readiness-observer', 'installReadinessObserver();'],
  ['schedule-random-reload', 'scheduleRandomReload();'],
  ['schedule-batch-flush', 'scheduleBatchFlush();'],
  ['hold-web-lock-until-release', 'await new Promise((resolve) => {\n            releaseWebLock = resolve;'],
  ['fall-back-to-standby-when-web-lock-fails', 'console.warn("[Alliance Discord] Web Lock authority unavailable.", error);']
];

const EXPECTED_RUNTIME_CONTRACT = {
  apiNames: API_NAMES,
  bootEffects: BOOT_EFFECTS.map(([name]) => name),
  storageKeys: {
    DEBUG_VERBOSE_STORAGE_KEY: 'travianAllianceDebugVerbose_v1',
    DIAGNOSTICS_STORAGE_KEY: 'travianAllianceDiagnostics_v2',
    DISCORD_CONFIG_STORAGE_KEY: 'travianAllianceDiscordConfig_v1',
    FAILED_BATCH_STORAGE_KEY: 'travianAllianceFailedBatch_v1',
    HISTORY_STORAGE_KEY: 'travianAllianceHistory_v1',
    MAPPING_STORAGE_KEY: 'travianAlliancePlayerMappings_v1',
    MONITOR_ACTIVE_STORAGE_KEY_PREFIX: 'travianAllianceMonitor_v1:',
    MONITOR_BACKUP_STORAGE_KEY_PREFIX: 'travianAllianceMonitorBackup_v1:',
    MONITOR_QUARANTINE_STORAGE_KEY_PREFIX: 'travianAllianceMonitorQuarantine_v1:',
    MUTED_PLAYERS_STORAGE_KEY: 'travianAllianceMutedPlayers_v1',
    PENDING_BATCH_STORAGE_KEY: 'travianAlliancePendingBatch_v1',
    PLAYER_NAMES_STORAGE_KEY: 'travianAlliancePlayerNames_v1',
    ROSTER_STORAGE_KEY: 'travianAllianceRoster_v1',
    SETTINGS_STORAGE_KEY: 'travianAllianceSettings_v1',
    STORAGE_KEY: 'travianAllianceIncomingAttacks_v40',
    TAB_LEASE_STORAGE_KEY: 'travianAllianceTabLease_v1',
    WEBHOOK_STORAGE_KEY: 'travianAllianceWebhookUrl_v1'
  },
  menuCommands: [
    'Open alert monitor panel',
    'Send TEST batch to Discord',
    'Send TEST raid-only batch to Discord',
    'Scan now',
    'Clear attack memory',
    'Add Discord mapping',
    'Remove Discord mapping',
    'List Discord mappings',
    'Set alert role ID',
    'Clear alert role ID',
    'Show alert role ID',
    'Set leave-moderator role ID',
    'Clear leave-moderator role ID',
    'Show leave-moderator role ID',
    'Set Discord webhook URL',
    'Clear Discord webhook URL',
    'Show Discord webhook status',
    'Retry failed Discord batches',
    'Retry uncertain Discord batches',
    'Mark uncertain Discord batches delivered',
    'Flush pending Discord batches',
    'Load history and health',
    'Toggle debug details',
    'Add muted player',
    'Remove muted player',
    'List muted players'
  ],
  routeRoles: {
    names: {
      ALLIANCE_NONCANONICAL: 'alliance-noncanonical',
      CANONICAL_MEMBER: 'canonical-member',
      UNSUPPORTED: 'unsupported'
    },
    fixtures: [
      ['https://world.example/alliance/profile/members', 'canonical-member'],
      ['https://world.example/alliance/profile/members/', 'canonical-member'],
      ['https://world.example/alliance/profile/members?page=2', 'alliance-noncanonical'],
      ['https://world.example/alliance', 'alliance-noncanonical'],
      ['https://world.example/village', 'unsupported'],
      ['not a URL', 'unsupported']
    ]
  },
  releaseIdentity: {
    headerVersion: '1.0.0',
    manifestReleaseId: 'taa-1.0.0',
    manifestVersion: '1.0.0',
    metadataReleaseId: 'taa-1.0.0',
    metadataVersion: '1.0.0',
    packageVersion: '1.0.0',
    runtimeReleaseId: 'taa-1.0.0',
    runtimeVersion: '1.0.0'
  }
};

function requiredMatch(pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `runtime oracle is missing ${label}`);
  return match[1];
}

function storageKeySnapshot() {
  const entries = [...source.matchAll(/const\s+([A-Z0-9_]*(?:STORAGE_KEY|STORAGE_KEY_PREFIX))\s*=\s*"([^"]+)";/gu)]
    .map(([, name, value]) => [name, value])
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  return Object.fromEntries(entries);
}

function menuCommandSnapshot() {
  return [...source.matchAll(/GM_registerMenuCommand\(\s*"([^"]+)"/gu)].map(match => match[1]);
}

function bootEffectSnapshot() {
  const browserBranch = source.slice(source.indexOf('  function startBrowserRuntime() {'), source.indexOf('  if (typeof module !== "undefined" && module.exports) {'));
  assert.ok(browserBranch.length > 0, 'browser boot branch is present');
  return BOOT_EFFECTS.map(([name, oracleText]) => {
    assert.ok(browserBranch.includes(oracleText), `browser boot effect changed: ${name}`);
    return name;
  });
}

function releaseIdentitySnapshot() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, 'metadata.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'module-manifest.json'), 'utf8'));
  const distText = fs.readFileSync(path.join(ROOT, 'dist', 'travian-attack-alert.user.js'), 'utf8');
  const distHeaderMatch = distText.match(/^\/\/ @version\s+([^\s]+)$/mu);
  assert.ok(distHeaderMatch, 'dist userscript header must declare @version');
  return {
    headerVersion: distHeaderMatch[1],
    manifestReleaseId: manifest.release.releaseId,
    manifestVersion: manifest.release.version,
    metadataReleaseId: metadata.release.releaseId,
    metadataVersion: metadata.release.version,
    packageVersion: packageJson.version,
    runtimeReleaseId: requiredMatch(/const RELEASE_ID = "([^"]+)";/u, 'RELEASE_ID'),
    runtimeVersion: requiredMatch(/const RELEASE_VERSION = "([^"]+)";/u, 'RELEASE_VERSION')
  };
}

function runtimeContractSnapshot() {
  const routeFixtures = EXPECTED_RUNTIME_CONTRACT.routeRoles.fixtures.map(([url]) => [
    url,
    runtime.classifyAllianceRoute(url).role
  ]);
  return {
    apiNames: Object.keys(runtime).sort(),
    bootEffects: bootEffectSnapshot(),
    storageKeys: storageKeySnapshot(),
    menuCommands: menuCommandSnapshot(),
    routeRoles: { names: runtime.ROUTE_ROLES, fixtures: routeFixtures },
    releaseIdentity: releaseIdentitySnapshot()
  };
}

// Post-cutover parity guard: src/runtime.js is now the sole editable runtime
// authority. This test preserves the frozen oracle established before script.txt
// was deleted (task-4/parity.json: 324 oracle exports preserved + startBrowserRuntime).
// Source API names, storage keys, menu commands, and boot effects are read from
// src/runtime.js; release identity comes from dist/*.user.js + metadata.json +
// package.json + module-manifest.json. Every EXPECTED value below is identical
// to the pre-deletion oracle contract.

test('post-cutover src/runtime.js matches the frozen offline parity contract', () => {
  assert.deepEqual(runtimeContractSnapshot(), EXPECTED_RUNTIME_CONTRACT);
});

test('parity snapshot is deterministic and contains synthetic route input only', () => {
  const first = runtimeContractSnapshot();
  assert.deepEqual(runtimeContractSnapshot(), first);
  for (const [url] of first.routeRoles.fixtures) {
    if (url.includes('://')) assert.equal(new URL(url).hostname, 'world.example');
  }
  assert.doesNotMatch(JSON.stringify(first), /detectedAt|generatedAt|timestamp/u);
});

module.exports = { EXPECTED_RUNTIME_CONTRACT, runtimeContractSnapshot };
