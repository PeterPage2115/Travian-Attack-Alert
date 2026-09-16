'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtimeApi = require(path.join(root, 'src', 'runtime-api.js'));
const constants = require(path.join(root, 'src', 'constants.js'));
const parser = require(path.join(root, 'src', 'parser.js'));
const text = require(path.join(root, 'src', 'text.js'));
const route = require(path.join(root, 'src', 'route.js'));
const transport = require(path.join(root, 'src', 'transport.js'));
const snapshot = require(path.join(root, 'src', 'snapshot.js'));
const discord = require(path.join(root, 'src', 'discord.js'));
const migration = require(path.join(root, 'src', 'migration.js'));
const envelope = require(path.join(root, 'src', 'envelope.js'));
const dispatch = require(path.join(root, 'src', 'dispatch.js'));
const conservation = require(path.join(root, 'src', 'conservation.js'));
const diagnostics = require(path.join(root, 'src', 'diagnostics.js'));

const MIGRATION_CONTRACT = [
    'LEGACY_CANONICAL_EVENT_FIELDS', 'canonicalLegacyEventFields',
    'canonicalizeLegacyActiveEvent', 'canonicalizeLegacyHistoryRecord',
    'decodeLegacyIdentity', 'planMonitorLegacyMigration',
    'migrateLegacyMonitorStateV1', 'loadOrMigrateMonitorEnvelopeV1',
    'encodeSourceTuple', 'sourceEventIdFromTuple', 'sourceEventTuple',
    'decodeSourceEventId'
];
const ENVELOPE_CONTRACT = [
    'canonicalSerializeMonitorValue', 'checksumMonitorCanonicalValue',
    'createMonitorEnvelopeV1', 'serializeMonitorEnvelopeV1',
    'parseMonitorEnvelopeV1', 'compareMonitorGenerations',
    'isMonitorGenerationFenced', 'monitorActiveStorageKey',
    'monitorBackupStorageKey', 'monitorQuarantineStorageKey',
    'quarantineMonitorRawV1', 'loadMonitorEnvelopeV1',
    'coalesceMonitorPendingEvents', 'planAcceptedScanTransition',
    'commitMonitorEnvelope', 'commitMonitorEnvelopeV1',
    'applyMonitorQueueTransitionV1', 'commitMonitorQueueTransitionV1',
    'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
    'resumeTerminalCompactionV1', 'createMonitorQueueEvent',
    'computeQueueAge', 'addInFlightChunk', 'getInFlightChunks',
    'dropInFlightHead', 'replaceInFlightHeadAttempt'
];
const DISPATCH_CONTRACT = [
    'buildDispatchPlanV1', 'buildDispatchRequestV1',
    'ackHashForDiscordMessageId', 'applyDispatchPlanTransitionV1',
    'createDispatchPlanInAccountingV1', 'commitDispatchPlanTransitionV1'
];
const CONSERVATION_CONTRACT = [
    'sourceEventIdFromTuple', 'sourceEventTuple',
    'createMonitorQueueEvent', 'coalesceMonitorPendingEvents',
    'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1',
    'resumeTerminalCompactionV1'
];
const DIAGNOSTICS_CONTRACT = [
    'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
    'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
    'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
    'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
    'serializeDiagnosticExportV2', 'boundedDiagnosticRecords',
    'monotonicDurationMs', 'recordDuration', 'createVisibilityDriftTracker',
    'updateVisibilityDriftTracker', 'buildScanSummaryLog', 'recordFailure'
];

function selected(names) {
    return runtimeApi.select('pure-module-parity', names);
}

test('pure seams preserve the legacy public names and fixture outputs', () => {
    const contracts = [
        ['constants', constants, Object.keys(constants)],
        ['parser', parser, Object.keys(parser)],
        ['text', text, Object.keys(text)],
        ['route', route, Object.keys(route)],
        ['transport', transport, Object.keys(transport)],
        ['snapshot', snapshot, Object.keys(snapshot)],
        ['discord', discord, Object.keys(discord)],
        ['migration', migration, MIGRATION_CONTRACT],
        ['envelope', envelope, ENVELOPE_CONTRACT],
        ['dispatch', dispatch, DISPATCH_CONTRACT],
        ['conservation', conservation, CONSERVATION_CONTRACT],
        ['diagnostics', diagnostics, DIAGNOSTICS_CONTRACT]
    ];
    for (const [name, actual, names] of contracts) {
        assert.deepEqual(Object.keys(actual).sort(), names.slice().sort(), `${name} export mismatch`);
        if (name === 'constants') assert.deepEqual(actual, selected(names), `${name} exports differ from runtime contract`);
        else for (const exportName of names) assert.equal(typeof actual[exportName], typeof selected([exportName])[exportName], `${name}.${exportName} type differs`);
    }

    const textLegacy = selected(Object.keys(text));
    const textFixtures = [
        ['truncateText', ['zażółć gęślą jaźń 😀', 8]],
        ['truncateText', ['abcdef', 0]],
        ['truncateText', ['abcdef', 3.9]],
        ['encodeMarkdownUrl', ['https://example.test/a b/(c)<>']],
        ['safeProfileUrl', [' /profile/42 ', { origin: 'https://cw.example', fallbackHref: 'https://cw.example/alliance/profile/members' }]],
        ['safeProfileUrl', ['https://evil.example/profile/42', { origin: 'https://cw.example', fallbackHref: 'https://cw.example/profile/7' }]],
        ['safeAllianceUrl', ['/alliance/profile/members', { origin: 'https://cw.example' }]],
        ['validateDiscordUserId', [' 123456789012345678 ']],
        ['validateDiscordRoleId', ['12345678901234567x']],
        ['validateWebhookUrl', ['https://discord.com/api/webhooks/123456789012345678/token']],
        ['validateWebhookUrl', ['https://discord.com/api/webhooks/123/token?wait=true']],
        ['sanitizeDiagnosticText', ['token=super-secret https://example.test/123456789 😀']],
        ['extractPlayerId', ['/profile/123']],
        ['extractPlayerId', ['/alliance/profile/123']],
        ['extractNameFromProfileHtml', ['<h1 class="titleInHeader">Żółć &amp; 😀</h1>']],
        ['normalizeProfileInput', ['https://cw.example/profile/123']],
        ['raidWord', [1]],
        ['raidWord', [2]]
    ];
    for (const [name, args] of textFixtures) {
        assert.deepEqual(text[name](...args), textLegacy[name](...args), `text fixture ${name}`);
    }

    const routeLegacy = selected(Object.keys(route));
    const routeFixtures = [
        ['https://cw.example/alliance/profile/members', route.classifyAllianceRoute],
        ['https://cw.example/alliance/profile/members/?foo=1', route.classifyAllianceRoute],
        ['https://cw.example/alliance/profile/members/', route.classifyAllianceRoute],
        ['https://cw.example/alliance', route.classifyAllianceRoute],
        ['not a URL', route.classifyAllianceRoute]
    ];
    for (const [input, classify] of routeFixtures) {
        assert.deepEqual(classify(input), routeLegacy.classifyAllianceRoute(input), `route fixture ${input}`);
    }
    for (const hostname of ['CW.Example.COM...', '  ', '', 'ż.example']) {
        assert.equal(route.lockNameForHostname(hostname), routeLegacy.lockNameForHostname(hostname));
    }
});

test('pure seams load when runtime resolution is blocked', () => {
    const probe = `
        const Module = require('node:module');
        const original = Module._resolveFilename;
        Module._resolveFilename = function(request, parent, isMain, options) {
            if (request.endsWith('/runtime.js') || request === '../runtime.js') throw new Error('runtime blocked');
            return original.call(this, request, parent, isMain, options);
        };
        for (const name of ['constants', 'parser', 'text', 'route', 'transport', 'snapshot', 'discord', 'migration', 'envelope', 'dispatch', 'conservation']) {
            const value = require(${JSON.stringify(path.join(root, 'src'))} + '/' + name + '.js');
            if (!value || Object.keys(value).length === 0) throw new Error(name + ' did not load');
        }
    `;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }));
});

test('migration and envelope preserve codec identities and representative transitions', () => {
    assert.deepEqual(Object.keys(migration).sort(), [...MIGRATION_CONTRACT].sort());
    assert.deepEqual(Object.keys(envelope).sort(), [...ENVELOPE_CONTRACT].sort());
    const tuple = {
        world: 'S1.Example', playerId: '42', eventType: 'attack',
        acceptedGeneration: 3, scanSequence: 7, attackDelta: 1, raidDelta: 0
    };
    const legacyMigration = selected(MIGRATION_CONTRACT);
    const legacyEnvelope = selected(ENVELOPE_CONTRACT);
    const sourceId = migration.sourceEventIdFromTuple(tuple);
    assert.equal(sourceId, legacyMigration.sourceEventIdFromTuple(tuple));
    assert.deepEqual(migration.decodeSourceEventId(sourceId), legacyMigration.decodeSourceEventId(sourceId));
    assert.deepEqual(migration.sourceEventTuple(tuple), legacyMigration.sourceEventTuple(tuple));
    assert.deepEqual(
        migration.canonicalLegacyEventFields({ name: 'Alpha', attackCount: 2, observedAtMs: 17 }),
        legacyMigration.canonicalLegacyEventFields({ name: 'Alpha', attackCount: 2, observedAtMs: 17 })
    );
    assert.equal(envelope.canonicalSerializeMonitorValue({ z: 1, a: [2, 3] }), legacyEnvelope.canonicalSerializeMonitorValue({ z: 1, a: [2, 3] }));
    assert.deepEqual(envelope.createMonitorEnvelopeV1('S1.Example', { nowMs: 10 }), legacyEnvelope.createMonitorEnvelopeV1('S1.Example', { nowMs: 10 }));
    assert.deepEqual(envelope.coalesceMonitorPendingEvents([], 2, 10), legacyEnvelope.coalesceMonitorPendingEvents([], 2, 10));
    assert.equal(envelope.resumeTerminalCompactionV1, envelope.compactDeliveryAccountingV1);
});

test('dispatch and conservation preserve plan identities and facade references', () => {
    assert.deepEqual(Object.keys(dispatch).sort(), [...DISPATCH_CONTRACT].sort());
    assert.deepEqual(Object.keys(conservation).sort(), [...CONSERVATION_CONTRACT].sort());
    const legacyDispatch = selected(DISPATCH_CONTRACT);
    const legacyConservation = selected(CONSERVATION_CONTRACT);
    const plan = dispatch.buildDispatchPlanV1([], { chunkSize: 2, generation: 1 });
    assert.deepEqual(plan, legacyDispatch.buildDispatchPlanV1([], { chunkSize: 2, generation: 1 }));
    assert.equal(dispatch.ackHashForDiscordMessageId('message-9'), legacyDispatch.ackHashForDiscordMessageId('message-9'));
    assert.equal(dispatch.applyDispatchPlanTransitionV1(plan, { type: 'bogus' }), null);
    const tuple = {
        world: 'S1.Example', playerId: '42', eventType: 'raid',
        acceptedGeneration: 2, scanSequence: 4, attackDelta: 0, raidDelta: 1
    };
    assert.equal(conservation.sourceEventIdFromTuple(tuple), legacyConservation.sourceEventIdFromTuple(tuple));
    assert.deepEqual(conservation.coalesceMonitorPendingEvents([], 2, 10), legacyConservation.coalesceMonitorPendingEvents([], 2, 10));
    assert.equal(conservation.resumeTerminalCompactionV1, conservation.compactDeliveryAccountingV1);
    const envelopeImpl = require(path.join(root, 'src', 'envelope-impl.js'));
    const migrationImpl = require(path.join(root, 'src', 'migration-impl.js'));
    const conservationImpl = require(path.join(root, 'src', 'conservation-impl.js'));
    for (const name of ['coalesceMonitorPendingEvents', 'compactDeliveryAccountingV1', 'prepareTerminalCompactionV1', 'resumeTerminalCompactionV1', 'createMonitorQueueEvent']) {
        assert.equal(conservationImpl[name], envelopeImpl[name], `${name} must re-export envelope-impl without duplicate logic`);
    }
    for (const name of ['sourceEventIdFromTuple', 'sourceEventTuple']) {
        assert.equal(conservationImpl[name], migrationImpl[name], `${name} must re-export migration-impl without duplicate logic`);
    }
});

test('diagnostics preserves bounded redaction and facade references', () => {
    assert.deepEqual(Object.keys(diagnostics).sort(), [...DIAGNOSTICS_CONTRACT].sort());
    const legacyDiagnostics = selected(DIAGNOSTICS_CONTRACT);
    const world = diagnostics.createDiagnosticsWorldV2('parity.test');
    assert.deepEqual(world, legacyDiagnostics.createDiagnosticsWorldV2('parity.test'));
    assert.deepEqual(
        diagnostics.appendDiagnosticTraceV2(world, { stage: 'snapshot', status: 'ok', reason: 'probe' }),
        legacyDiagnostics.appendDiagnosticTraceV2(world, { stage: 'snapshot', status: 'ok', reason: 'probe' })
    );
    assert.equal(diagnostics.serializeDiagnosticsConsoleV2(world), legacyDiagnostics.serializeDiagnosticsConsoleV2(world));
    assert.equal(diagnostics.serializeDiagnosticsExportV2('parity.test', world), legacyDiagnostics.serializeDiagnosticsExportV2('parity.test', world));
    assert.deepEqual(diagnostics.boundedDiagnosticRecords(world.records, {}), legacyDiagnostics.boundedDiagnosticRecords(world.records, {}));
    assert.deepEqual(diagnostics.recordFailure({}, 'parity.test', 1700000000000, 'probe', 1, 'no-member-table', { memberRows: 2 }), legacyDiagnostics.recordFailure({}, 'parity.test', 1700000000000, 'probe', 1, 'no-member-table', { memberRows: 2 }));
    const diagnosticsImpl = require(path.join(root, 'src', 'diagnostics-impl.js'));
    const kernel = [
        'createDiagnosticsWorldV2', 'appendDiagnosticTraceV2',
        'serializeDiagnosticsConsoleV2', 'serializeDiagnosticsExportV2',
        'recordDiagnosticTraceV2', 'createDiagnosticWorldV2',
        'appendDiagnosticRecordV2', 'serializeDiagnosticConsoleV2',
        'serializeDiagnosticExportV2',
    ];
    for (const name of kernel) {
        assert.equal(diagnosticsImpl[name], diagnostics[name], `${name} must re-export diagnostics-impl without duplicate logic`);
    }
    assert.equal(diagnostics.createDiagnosticWorldV2, diagnostics.createDiagnosticsWorldV2);
    assert.equal(diagnostics.appendDiagnosticRecordV2, diagnostics.appendDiagnosticTraceV2);
    assert.equal(diagnostics.serializeDiagnosticConsoleV2, diagnostics.serializeDiagnosticsConsoleV2);
    assert.equal(diagnostics.serializeDiagnosticExportV2, diagnostics.serializeDiagnosticsExportV2);
});

test('export-name mismatch is a hard parity failure', () => {
    const expected = Object.keys(selected(Object.keys(route))).sort();
    assert.deepEqual(Object.keys(route).sort(), expected);
});

test('pure seams pin independent golden behavior', () => {
    assert.equal(constants.DISCORD_CONTENT_LIMIT, 2000);
    assert.equal(constants.EMBED_DESCRIPTION_LIMIT, 4096);
    assert.equal(constants.QUEUE_MAX_EVENTS, 50);
    assert.equal(constants.TAB_LEASE_TTL_MS, 120000);
    assert.equal(constants.ROUTE_ROLES.CANONICAL_MEMBER, 'canonical-member');
    assert.deepEqual(Array.from(constants.MEMBER_TABLE_REASON_CODES), ['no-member-table', 'multiple-member-tables', 'pagination-or-filter', 'missing-player-id', 'duplicate-player-id', 'conflicting-tooltip', 'malformed-count']);

    assert.deepEqual(route.classifyAllianceRoute('https://cw.example/alliance/profile/members'), { role: 'canonical-member', pathname: '/alliance/profile/members', query: '' });
    assert.deepEqual(route.classifyAllianceRoute('https://cw.example/alliance/profile/members?foo=1'), { role: 'alliance-noncanonical', pathname: '/alliance/profile/members', query: '?foo=1' });
    assert.deepEqual(route.classifyAllianceRoute('not a URL'), { role: 'unsupported', pathname: '', query: '' });
    assert.equal(route.lockNameForHostname('CW.Example.COM...'), 'taa-monitor:cw.example.com');

    assert.equal(text.validateDiscordRoleId('123456789012345678'), '123456789012345678');
    assert.equal(text.validateDiscordRoleId('12345678901234567x'), null);
    assert.equal(text.truncateText('abcdef', 3), 'abc');
    assert.equal(text.truncateText('abcdef', 6), 'abcdef');
    assert.equal(text.truncateText('abcdef', 0), '');
    assert.equal(text.raidWord(1), 'raid');
    assert.equal(text.raidWord(2), 'raids');
});
