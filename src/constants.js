'use strict';

/** Stable configuration, storage-key, and protocol-limit contracts. */
const ROUTE_ROLES = Object.freeze({ CANONICAL_MEMBER: 'canonical-member', ALLIANCE_NONCANONICAL: 'alliance-noncanonical', UNSUPPORTED: 'unsupported' });
const PRIORITY_COLORS = { normal: 15158332, high: 15844367, critical: 10038562 };
const constants = {
    ROUTE_ROLES, PRIORITY_COLORS, DISCORD_CONTENT_LIMIT: 2000,
    EMBED_DESCRIPTION_LIMIT: 4096, EMBED_FIELD_VALUE_LIMIT: 1024,
    EMBED_TOTAL_TEXT_LIMIT: 6000, DISCORD_EMBEDS_LIMIT: 10,
    EMBED_DESCRIPTION_SAFE_BUDGET: 3800, EMBED_TOTAL_SAFE_BUDGET: 5800,
    EVENT_NAME_MAX: 80, EVENT_URL_MAX: 300,
    SETTINGS_STORAGE_KEY: 'travianAllianceSettings_v1', HISTORY_STORAGE_KEY: 'travianAllianceHistory_v1',
    HISTORY_MAX_EVENTS: 500, PENDING_BATCH_STORAGE_KEY: 'travianAlliancePendingBatch_v1',
    BATCH_FLUSH_MS: 30000, QUEUE_MAX_EVENTS: 50, PAYLOAD_CHUNK_MAX: 20,
    DIAGNOSTICS_STORAGE_KEY: 'travianAllianceDiagnostics_v2', MAX_ATTEMPT_COUNT: 3,
    RETRY_DELAY_MS: [1000, 3000], WEBHOOK_STORAGE_KEY: 'travianAllianceWebhookUrl_v1',
    REQUEST_TIMEOUT_MS: 15000, MAX_RETRY_DELAY_MS: 60000, DRAIN_POLL_MS: 500,
    DRAIN_MAX_WAIT_MS: 45000, MONITOR_ENVELOPE_SCHEMA_VERSION: 1,
    MONITOR_ACTIVE_STORAGE_KEY_PREFIX: 'travianAllianceMonitor_v1:',
    MONITOR_BACKUP_STORAGE_KEY_PREFIX: 'travianAllianceMonitorBackup_v1:',
    MONITOR_QUARANTINE_STORAGE_KEY_PREFIX: 'travianAllianceMonitorQuarantine_v1:',
    MONITOR_MAX_PENDING_RECORDS: 512, MONITOR_QUARANTINE_MAX_ENTRIES: 3,
    MONITOR_QUARANTINE_MAX_BYTES: 131072,
    DISPATCH_CHUNK_STATES: Object.freeze(['prepared', 'sending', 'acknowledged', 'retryable', 'failed', 'uncertain']),
    FAILED_BATCH_STORAGE_KEY: 'travianAllianceFailedBatch_v1', FAILED_QUEUE_MAX_EVENTS: 50,
    TAB_LEASE_STORAGE_KEY: 'travianAllianceTabLease_v1', TAB_LEASE_TTL_MS: 120000,
    TAB_LEASE_RENEW_MS: 30000, TAB_LEASE_RETRY_MS: 10000, DIAGNOSTICS_SCHEMA_VERSION: 2,
    DIAGNOSTICS_LIMITS: Object.freeze({ records: 256, recordBytes: 4096, worldBytes: 256 * 1024, ids: 32, consoleBytes: 2048, exportBytes: 512 * 1024 }),
    DEBUG_VERBOSE_STORAGE_KEY: 'travianAllianceDebugVerbose_v1', PANEL_BACKFILL_ORPHAN_CAP: 12,
    MEMBER_TABLE_REASON_CODES: Object.freeze(['no-member-table', 'multiple-member-tables', 'pagination-or-filter', 'missing-player-id', 'duplicate-player-id', 'conflicting-tooltip', 'malformed-count']),
    STARTUP_ACQUIRE_JITTER_MIN_MS: 25, STARTUP_ACQUIRE_JITTER_MAX_MS: 250,
    NAME_NOT_FOUND_TTL_MS: 7 * 24 * 60 * 60 * 1000, PLAYER_NAMES_STORAGE_KEY: 'travianAlliancePlayerNames_v1',
    PLAYER_NAMES_NOT_FOUND_KEY: 'travianAlliancePlayerNamesNotFound_v1', ROSTER_STORAGE_KEY: 'travianAllianceRoster_v1'
};
module.exports = constants;
