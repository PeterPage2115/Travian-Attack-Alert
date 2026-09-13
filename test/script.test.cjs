'use strict';

/*
 * Testy node:test dla czystych funkcji eksportowanych z ../script.txt
 * (Travian - Alliance Attacks to Discord, wersja 4.6).
 *
 * Zasady:
 *   - ŻADEN test nie wykonuje HTTP (brak GM_xmlhttpRequest, brak fetch),
 *   - ŻADEN test nie wymaga GM API ani przeglądarki (brak document/location),
 *   - wszystkie testy są deterministyczne (stałe timestampy, brak losowości).
 *
 * Uruchomienie: npm test   (== node --test)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.TZ = 'UTC';

const script = Object.assign({},
    require('../src/constants.js'), require('../src/text.js'),
    require('../src/storage.js'), require('../src/lease.js'),
    require('../src/route.js'), require('../src/parser.js'),
    require('../src/snapshot.js'), require('../src/envelope.js'),
    require('../src/migration.js'), require('../src/discord.js'),
    require('../src/transport.js'), require('../src/dispatch.js'),
    require('../src/conservation.js'),
    require('../src/diagnostics.js'), require('../src/panel.js'),
    require('../src/acquisition.js')
);
script.buildPlayerWorkspaceReadModel = require('../script.txt').buildPlayerWorkspaceReadModel;
script.inspectMappingStorage = require('../script.txt').inspectMappingStorage;
script.inspectDiscordConfigStorage = require('../script.txt').inspectDiscordConfigStorage;
script.loadMappingsProvenance = require('../script.txt').loadMappingsProvenance;
script.loadDiscordConfigProvenance = require('../script.txt').loadDiscordConfigProvenance;
script.buildStorageProvenanceModel = require('../script.txt').buildStorageProvenanceModel;
script.storageProvenanceText = require('../script.txt').storageProvenanceText;
script.applySettingsBackup = require('../script.txt').applySettingsBackup;
script.buildSettingsBackup = require('../script.txt').buildSettingsBackup;
// task-3 panel clarity additions (delimited): textual panel-state models owned by script.txt.
script.formatPlayerPaginationStatus = require('../script.txt').formatPlayerPaginationStatus;
script.describePlayerFilterState = require('../script.txt').describePlayerFilterState;
script.formatTraceCountStatus = require('../script.txt').formatTraceCountStatus;
script.describeFreshnessState = require('../script.txt').describeFreshnessState;
script.describeAlertRoleError = require('../script.txt').describeAlertRoleError;
script.describeAlertThresholdError = require('../script.txt').describeAlertThresholdError;
script.enqueueEvents = require('../script.txt').enqueueEvents;
script.QUEUE_MAX_EVENTS = require('../script.txt').QUEUE_MAX_EVENTS;
script.buildIncidentBundle = require('../script.txt').buildIncidentBundle;
script.buildSettingsBackup = require('../script.txt').buildSettingsBackup;
script.MAPPING_STORAGE_KEY = require('../script.txt').MAPPING_STORAGE_KEY;
script.NAME_NOT_FOUND_TTL_MS = require('../script.txt').NAME_NOT_FOUND_TTL_MS;
script.NAME_BACKFILL_TIMEOUT_MS = require('../script.txt').NAME_BACKFILL_TIMEOUT_MS;
script.NAME_BACKFILL_MAX_CONCURRENCY = require('../script.txt').NAME_BACKFILL_MAX_CONCURRENCY;
script.runNameBackfill = require('../script.txt').runNameBackfill;
// task-1 scan-cycle contract: pure bounded helpers owned by script.txt.
script.SCAN_CYCLE_DEADLINE_MS = require('../script.txt').SCAN_CYCLE_DEADLINE_MS;
script.SCAN_CYCLE_QUIET_MS = require('../script.txt').SCAN_CYCLE_QUIET_MS;
script.SCAN_COMMIT_ERROR_REASONS = require('../script.txt').SCAN_COMMIT_ERROR_REASONS;
script.RELOAD_REFUSAL_REASONS = require('../script.txt').RELOAD_REFUSAL_REASONS;
script.isScanCycleReady = require('../script.txt').isScanCycleReady;
script.createScanCycleId = require('../script.txt').createScanCycleId;
script.decideScanCycleOutcome = require('../script.txt').decideScanCycleOutcome;
script.isScanTerminalRecord = require('../script.txt').isScanTerminalRecord;
script.selectScanTerminalRecord = require('../script.txt').selectScanTerminalRecord;
script.selectLatestScanTerminalRecord = require('../script.txt').selectLatestScanTerminalRecord;
script.describeScanTerminal = require('../script.txt').describeScanTerminal;
script.classifyReloadRefusal = require('../script.txt').classifyReloadRefusal;
const canonicalDiscord = require('./fixtures/discord/canonical.cjs');
const acquisition = require('./fixtures/acquisition/sanitizer.cjs');
const acquisitionBrowser = require('./fixtures/acquisition/browser-harness.cjs');
const evidenceRunner = require('./fixtures/stabilization/evidence-runner.cjs');
const conservation = require('./fixtures/stabilization/conservation-oracle.cjs');

test('route classifier accepts only the exact query-free canonical member route', () => {
    assert.equal(script.classifyAllianceRoute('https://world.example/alliance/profile/members').role, 'canonical-member');
    assert.equal(script.classifyAllianceRoute('https://world.example/alliance/profile/members/').role, 'canonical-member');
});

test('route classifier rejects query and prefix-confusable member routes', () => {
    for (const value of [
        'https://world.example/alliance/profile/members?page=2',
        'https://world.example/alliance/profile/members?foo',
        'https://world.example/alliance/profile/members/extra',
        'https://world.example/alliance/profile/memberships'
    ]) {
        assert.notEqual(script.classifyAllianceRoute(value).role, 'canonical-member');
    }
});

test('route classifier identifies matched alliance routes as noncanonical', () => {
    for (const pathname of ['/alliance', '/alliance/', '/alliance/profile', '/alliance/overview', '/alliance/reports']) {
        assert.equal(script.classifyAllianceRoute(`https://world.example${pathname}`).role, 'alliance-noncanonical');
    }
    assert.equal(script.classifyAllianceRoute('https://world.example/village').role, 'unsupported');
});

test('lease fencing requires owner, term, and generation', () => {
    assert.equal(script.isLeaseFenceValid({ ownerId: 'a', term: 3, generation: 8 }, { ownerId: 'a', term: 3, generation: 8 }), true);
    assert.equal(script.isLeaseFenceValid({ ownerId: 'a', term: 2, generation: 8 }, { ownerId: 'a', term: 3, generation: 8 }), false);
    assert.equal(script.lockNameForHostname('WORLD.Example.'), 'taa-monitor:world.example');
});

function readDocumentMarker(source, name) {
    const startMarker = `<!-- ${name}:start -->`;
    const endMarker = `<!-- ${name}:end -->`;
    assert.equal(source.split(startMarker).length, 2, `${name} start marker is unique`);
    assert.equal(source.split(endMarker).length, 2, `${name} end marker is unique`);
    const start = source.indexOf(startMarker) + startMarker.length;
    const end = source.indexOf(endMarker);
    assert.equal(source[start], '\n');
    assert.equal(source[end - 1], '\n');
    return source.slice(start + 1, end - 1);
}

function contract610ReleaseIdentity({ scriptSource, readme, packageJson, metadata, manifest, diagnostics, incidentBundle }) {
const version = '6.2.1';
const releaseId = 'taa-6.2.1';
    assert.match(scriptSource, new RegExp(`^// @version\\s+${version.replaceAll('.', '\\.')}$`, 'm'));
    assert.match(readme, new RegExp(`Tampermonkey \\*\\*${version.replaceAll('.', '\\.')}`));
    assert.equal(packageJson.version, version);
    assert.deepEqual(metadata.release, { version, releaseId });
    assert.deepEqual(manifest.release, { version, releaseId });
    assert.equal(diagnostics.releaseId, releaseId);
    assert.equal(incidentBundle.build.version, version);
    assert.equal(incidentBundle.build.releaseId, releaseId);
    return { version, releaseId };
}

test('release identity contract is invoked for the active distributable', () => {
    const scriptSource = fs.readFileSync(require.resolve('../script.txt'), 'utf8');
    const readme = fs.readFileSync(require.resolve('../README.md'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8'));
    const metadata = JSON.parse(fs.readFileSync(require.resolve('../metadata.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../module-manifest.json'), 'utf8'));
    const diagnostics = script.buildDiagnosticsPanelModel({ atMs: 0, statusOrError: 'ok' });
    const incidentBundle = script.buildIncidentBundle({ envelope: {}, diagnostics: {}, traces: [] });
     assert.deepEqual(contract610ReleaseIdentity({ scriptSource, readme, packageJson, metadata, manifest, diagnostics, incidentBundle }), {
     version: '6.2.1',
     releaseId: 'taa-6.2.1'
    });
});

const HOST = 'cw.x2.international.travian.com';
const UID_A = '123456789012345678';

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}
const UID_B = '234567890123456789';
const ROLE = '987654321098765432';

function memoryStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

// ---------------------------------------------------------------------------
// Parser ataków / grabieży
// ---------------------------------------------------------------------------

test('parseAttackCount: formy PL/EN/DE', () => {
    assert.equal(script.parseAttackCount('3 ataki'), 3);
    assert.equal(script.parseAttackCount('1 atak'), 1);
    assert.equal(script.parseAttackCount('2 ataków'), 2);
    assert.equal(script.parseAttackCount('4 attacks'), 4);
    assert.equal(script.parseAttackCount('1 attack'), 1);
    assert.equal(script.parseAttackCount('5 attack(s)'), 5);
    assert.equal(script.parseAttackCount('3 Angriffe'), 3);
    assert.equal(script.parseAttackCount('7 attacków'), 7);
});

test('parseAttackCount: wartości odrzucane', () => {
    assert.equal(script.parseAttackCount('2 grabieże'), null);
    assert.equal(script.parseAttackCount('0 ataków'), null);
    assert.equal(script.parseAttackCount(''), null);
    assert.equal(script.parseAttackCount('brak ataków'), null);
    assert.equal(script.parseAttackCount('abc'), null);
    assert.equal(script.parseAttackCount(null), null);
    assert.equal(script.parseAttackCount(undefined), null);
});

test('parseRaidCount: formy PL/EN/DE', () => {
    assert.equal(script.parseRaidCount('2 grabieże'), 2);
    assert.equal(script.parseRaidCount('1 grabież'), 1);
    assert.equal(script.parseRaidCount('3 grabieży'), 3);
    assert.equal(script.parseRaidCount('4 raids'), 4);
    assert.equal(script.parseRaidCount('3 Raubzüge'), 3);
    assert.equal(script.parseRaidCount('2 Raubzuege'), 2);
    assert.equal(script.parseRaidCount('1 Raubzug'), 1);
});

test('parseRaidCount: wartości odrzucane', () => {
    assert.equal(script.parseRaidCount('3 ataki'), null);
    assert.equal(script.parseRaidCount('0 grabieży'), null);
    assert.equal(script.parseRaidCount(''), null);
    assert.equal(script.parseRaidCount('  '), null);
});

test('classifyEvent: liczniki niezależne', () => {
    assert.deepEqual(
        script.classifyEvent('3 ataki, 2 grabieże'),
        { attackCount: 3, raidCount: 2 }
    );
    assert.deepEqual(
        script.classifyEvent('2 grabieże'),
        { attackCount: null, raidCount: 2 }
    );
    assert.deepEqual(
        script.classifyEvent('1 atak'),
        { attackCount: 1, raidCount: null }
    );
    assert.deepEqual(
        script.classifyEvent(''),
        { attackCount: null, raidCount: null }
    );
});

test('isAttackIcon: klasa attack + dodatni licznik', () => {
    assert.equal(
        script.isAttackIcon({
            description: '3 ataki',
            className: 'attack'
        }),
        true
    );
    assert.equal(
        script.isAttackIcon({
            description: '2 grabieże',
            className: 'attack'
        }),
        true
    );
    assert.equal(
        script.isAttackIcon({
            description: '',
            className: 'attack'
        }),
        false
    );
    assert.equal(
        script.isAttackIcon({
            description: '3 ataki',
            className: 'defense'
        }),
        false
    );
    assert.equal(
        script.isAttackIcon({
            description: '3 ataki',
            hasAttackClass: true
        }),
        true
    );
});

// ---------------------------------------------------------------------------
// Diff stanów ataków / grabieży
// ---------------------------------------------------------------------------

test('diffAttackStates: wzrost ataków -> event attack', () => {
    const previous = {
        'player:Alice': { attackCount: 1, raidCount: 0 }
    };
    const current = {
        'player:Alice': { attackCount: 3, raidCount: 0 }
    };

    const { newEvents, shouldSave } =
        script.diffAttackStates(previous, current);

    assert.equal(shouldSave, true);
    assert.equal(newEvents.length, 1);
    assert.deepEqual(newEvents[0], {
        name: undefined,
        url: undefined,
        attackCount: 3,
        raidCount: 0,
        oldAttackCount: 1,
        oldRaidCount: 0,
        addedAttackCount: 2,
        addedRaidCount: 0,
        eventType: 'attack'
    });
});

test('diffAttackStates: wzrost grabieży -> event raid', () => {
    const previous = {
        'player:Bob': { attackCount: 2, raidCount: 1 }
    };
    const current = {
        'player:Bob': { attackCount: 2, raidCount: 4 }
    };

    const { newEvents } =
        script.diffAttackStates(previous, current);

    assert.equal(newEvents.length, 1);
    assert.equal(newEvents[0].eventType, 'raid');
    assert.equal(newEvents[0].addedRaidCount, 3);
    assert.equal(newEvents[0].addedAttackCount, 0);
});

test('diffAttackStates: wzrost obu -> event mixed', () => {
    const previous = {
        'player:Carol': { attackCount: 0, raidCount: 0 }
    };
    const current = {
        'player:Carol': { attackCount: 2, raidCount: 1 }
    };

    const { newEvents } =
        script.diffAttackStates(previous, current);

    assert.equal(newEvents.length, 1);
    assert.equal(newEvents[0].eventType, 'mixed');
    assert.equal(newEvents[0].addedAttackCount, 2);
    assert.equal(newEvents[0].addedRaidCount, 1);
});

test('diffAttackStates: brak zmian -> brak eventów', () => {
    const state = {
        'player:Dave': { attackCount: 5, raidCount: 2 }
    };

    const { newEvents, shouldSave } =
        script.diffAttackStates(state, state);

    assert.deepEqual(newEvents, []);
    assert.equal(shouldSave, true);
});

test('diffAttackStates: filterVersion jest pomijany', () => {
    const current = {
        filterVersion: 4,
        'player:Eve': { attackCount: 1, raidCount: 0, name: 'Eve' }
    };

    const { newEvents } =
        script.diffAttackStates({}, current);

    assert.equal(newEvents.length, 1);
    assert.equal(newEvents[0].name, 'Eve');
});

test('diffAttackStates: legacy licznik count i spadki', () => {
    const previous = {
        'player:Fly': { count: 10 }
    };
    const current = {
        'player:Fly': { attackCount: 7, raidCount: 0 }
    };

    const { newEvents } =
        script.diffAttackStates(previous, current);

    // Spadek nie tworzy eventu; legacy count=10 czytany jako attackCount.
    assert.deepEqual(newEvents, []);
});

test('diffAttackStates: puste stany', () => {
    const { newEvents, shouldSave } =
        script.diffAttackStates({}, {});

    assert.deepEqual(newEvents, []);
    assert.equal(shouldSave, false);
});

test('getStoredAttackCount / getStoredRaidCount / getStoredCount', () => {
    const state = {
        'player:Alice': { attackCount: 3, raidCount: 2 },
        'player:Legacy': { count: 7 },
        'player:Num': 5,
        filterVersion: 4
    };

    assert.equal(script.getStoredAttackCount(state, 'player:Alice'), 3);
    assert.equal(script.getStoredRaidCount(state, 'player:Alice'), 2);
    assert.equal(script.getStoredAttackCount(state, 'player:Legacy'), 7);
    assert.equal(script.getStoredRaidCount(state, 'player:Legacy'), 0);
    assert.equal(script.getStoredAttackCount(state, 'player:Num'), 5);
    assert.equal(script.getStoredAttackCount(state, 'filterVersion'), 0);
    assert.equal(script.getStoredCount(state, 'player:Alice'), 3);
});

test('shouldRebaseline: tylko stara pamięć z graczami', () => {
    assert.equal(script.shouldRebaseline({}), false);
    assert.equal(script.shouldRebaseline(null), false);
    assert.equal(script.shouldRebaseline({ filterVersion: 4 }), false);
    assert.equal(
        script.shouldRebaseline({ filterVersion: 3, 'player:X': {} }),
        true
    );
    assert.equal(
        script.shouldRebaseline({ 'player:X': { attackCount: 1 } }),
        true
    );
});

// ---------------------------------------------------------------------------
// Walidacja URL webhooka
// ---------------------------------------------------------------------------

test('validateWebhookUrl: poprawne URL-e', () => {
    const url = 'https://discord.com/api/webhooks/123456789/abcDEF-token';

    assert.equal(script.validateWebhookUrl(url), url);
    assert.equal(
        script.validateWebhookUrl(`  ${url}  `),
        url
    );
    assert.equal(
        script.validateWebhookUrl(
            'https://discord.com/api/webhooks/123/abc'
        ),
        'https://discord.com/api/webhooks/123/abc'
    );
});

test('validateWebhookUrl: odrzucane URL-e', () => {
    const base = 'https://discord.com/api/webhooks/123/token';

    assert.equal(
        script.validateWebhookUrl(
            'http://discord.com/api/webhooks/123/token'
        ),
        null
    );
    assert.equal(
        script.validateWebhookUrl(
            'https://discordapp.com/api/webhooks/123/token'
        ),
        null
    );
    assert.equal(
        script.validateWebhookUrl(
            'https://discord.com/api/webhooks/abc/token'
        ),
        null
    );
    assert.equal(
        script.validateWebhookUrl(
            'https://discord.com/api/webhooks/123/'
        ),
        null
    );
    assert.equal(
        script.validateWebhookUrl(
            'https://discord.com/api/webhooks/123/token?x=1'
        ),
        null
    );
    assert.equal(
        script.validateWebhookUrl(
            'https://discord.com/api/webhooks/123/token#frag'
        ),
        null
    );
    assert.equal(script.validateWebhookUrl(''), null);
    assert.equal(script.validateWebhookUrl('   '), null);
    assert.equal(script.validateWebhookUrl(null), null);
    assert.equal(script.validateWebhookUrl(123), null);
    assert.equal(script.validateWebhookUrl('not a url'), null);
});

test('webhook storage bez GM API: bezpieczne no-opy', () => {
    assert.equal(script.loadWebhookUrl(), null);
    assert.equal(
        script.saveWebhookUrl('https://discord.com/api/webhooks/1/t'),
        false
    );
    assert.equal(script.clearWebhookUrl(), false);
});

// ---------------------------------------------------------------------------
// Retry / Retry-After
// ---------------------------------------------------------------------------

test('isRetryableOutcome: błędy sieci, timeout, abort', () => {
    assert.equal(script.isRetryableOutcome(null, 'network'), true);
    assert.equal(script.isRetryableOutcome(null, 'timeout'), true);
    assert.equal(script.isRetryableOutcome(null, 'abort'), true);
    assert.equal(script.isRetryableOutcome(null, 'configuration'), false);
    assert.equal(script.isRetryableOutcome(null, undefined), false);
    assert.equal(script.isRetryableOutcome(null, null), false);
});

test('isRetryableOutcome: statusy HTTP', () => {
    assert.equal(script.isRetryableOutcome(408), true);
    assert.equal(script.isRetryableOutcome(429), true);
    assert.equal(script.isRetryableOutcome(500), true);
    assert.equal(script.isRetryableOutcome(503), true);
    assert.equal(script.isRetryableOutcome(599), true);
    assert.equal(script.isRetryableOutcome(200), false);
    assert.equal(script.isRetryableOutcome(204), false);
    assert.equal(script.isRetryableOutcome(302), false);
    assert.equal(script.isRetryableOutcome(400), false);
    assert.equal(script.isRetryableOutcome(401), false);
    assert.equal(script.isRetryableOutcome(404), false);
});

test('parseRetryAfterMs: retry_after z body JSON', () => {
    assert.equal(
        script.parseRetryAfterMs({
            responseText: '{"retry_after": 2.5}'
        }),
        2500
    );
    assert.equal(
        script.parseRetryAfterMs({
            responseText: '{"retry_after": 0}'
        }),
        0
    );
    assert.equal(
        script.parseRetryAfterMs({
            responseText: '{"retry_after": -1}'
        }),
        null
    );
});

test('parseRetryAfterMs: nagłówek Retry-After (sekundy)', () => {
    assert.equal(
        script.parseRetryAfterMs({
            responseHeaders: 'Retry-After: 3\r\nX-Foo: bar'
        }),
        3000
    );
    assert.equal(
        script.parseRetryAfterMs({
            responseHeaders: 'retry-after: 5\ncontent-type: text/plain'
        }),
        5000
    );
});

test('parseRetryAfterMs: nagłówek Retry-After (HTTP-date)', () => {
    const past = script.parseRetryAfterMs({
        responseHeaders: 'Retry-After: Mon, 01 Jan 2018 00:00:00 GMT'
    });

    assert.equal(past, 0);

    const future = script.parseRetryAfterMs({
        responseHeaders: 'Retry-After: Fri, 31 Dec 2099 23:59:59 GMT'
    });

    assert.ok(Number.isFinite(future));
    assert.ok(future > 0);
});

test('Discord response transport: retryable 429 honours both retry hints and then acknowledges', async () => {
    const webhookUrl = 'https://discord.com/api/webhooks/123456789012345678/fake_token_test_only';
    let requestCount = 0;
    let nowMs = 0;
    const delays = [];
    const result = await script.sendDiscordPayloadWithRetry({
        webhookUrl,
        payload: { content: 'fixture' },
        maxAttempts: 3,
        nowMs: () => nowMs,
        sleep: async delay => { delays.push(delay); nowMs += delay; },
        gmRequest: options => {
            requestCount += 1;
            options.onload(requestCount === 1
                ? {
                    status: 429,
                    responseText: JSON.stringify({ retry_after: 1 }),
                    responseHeaders: 'Retry-After: 1'
                }
                : { status: 200, responseText: JSON.stringify({ id: 'm1' }) });
        }
    });
    assert.equal(result.outcome.kind, 'acknowledged');
    assert.equal(requestCount, 2);
    assert.deepEqual(delays, [1000]);
});

test('parseRetryAfterMs: brak/nieparsowalne wartości', () => {
    assert.equal(script.parseRetryAfterMs(null), null);
    assert.equal(script.parseRetryAfterMs({}), null);
    assert.equal(script.parseRetryAfterMs({ responseText: 'nie json' }), null);
    assert.equal(
        script.parseRetryAfterMs({ responseText: '{"x": 1}' }),
        null
    );
    assert.equal(
        script.parseRetryAfterMs({
            responseHeaders: 'Retry-After: abc'
        }),
        null
    );
});

test('sanitizeRetryDelay: sanityzacja opóźnień', () => {
    assert.equal(script.sanitizeRetryDelay(2500, 1000), 2500);
    assert.equal(script.sanitizeRetryDelay(1234.7, 1000), 1234);
    assert.equal(script.sanitizeRetryDelay(70000, 1000), 60000);
    assert.equal(script.sanitizeRetryDelay(-5, 1000), 1000);
    assert.equal(script.sanitizeRetryDelay(NaN, 1000), 1000);
    assert.equal(script.sanitizeRetryDelay(Infinity, 500), 500);
    assert.equal(script.sanitizeRetryDelay(undefined, 1000), 1000);
    assert.equal(script.sanitizeRetryDelay(10, undefined), 10);
    assert.equal(script.sanitizeRetryDelay(NaN, NaN), 1000);
});

// ---------------------------------------------------------------------------
// Ustawienia / progi / priorytety
// ---------------------------------------------------------------------------

test('getDefaultSettings: świeża kopia domyślnych', () => {
    const a = script.getDefaultSettings();
    const b = script.getDefaultSettings();

    assert.deepEqual(a, {
        attackThreshold: 1,
        raidThreshold: 1,
        normalMax: 2,
        highMax: 5
    });
    assert.notEqual(a, b); // niezależne referencje
});

test('validateSettings: poprawne wartości', () => {
    const settings = {
        attackThreshold: 5,
        raidThreshold: 3,
        normalMax: 4,
        highMax: 10
    };

    assert.deepEqual(script.validateSettings(settings), settings);
});

test('validateSettings: clamp i fallbacki', () => {
    assert.deepEqual(script.validateSettings({ attackThreshold: 0 }), {
        attackThreshold: 1,
        raidThreshold: 1,
        normalMax: 2,
        highMax: 5
    });
    assert.deepEqual(script.validateSettings({ attackThreshold: 1500 }), {
        attackThreshold: 999,
        raidThreshold: 1,
        normalMax: 2,
        highMax: 5
    });
    assert.deepEqual(script.validateSettings({ attackThreshold: 2.9 }), {
        attackThreshold: 2,
        raidThreshold: 1,
        normalMax: 2,
        highMax: 5
    });
    assert.deepEqual(script.validateSettings({ raidThreshold: 'abc' }), {
        attackThreshold: 1,
        raidThreshold: 1,
        normalMax: 2,
        highMax: 5
    });
    assert.equal(
        script.validateSettings({ normalMax: 0 }).normalMax,
        1
    );
});

test('validateSettings: niespójne bandy wracają do domyślnych', () => {
    assert.deepEqual(script.validateSettings({
        attackThreshold: 3,
        raidThreshold: 3,
        normalMax: 5,
        highMax: 5
    }), {
        attackThreshold: 3,
        raidThreshold: 3,
        normalMax: 2,
        highMax: 5
    });
    assert.deepEqual(script.validateSettings({
        normalMax: 7,
        highMax: 3
    }), {
        attackThreshold: 1,
        raidThreshold: 1,
        normalMax: 2,
        highMax: 5
    });
});

test('validateSettings: zepsute wejścia -> domyślne', () => {
    const defaults = script.getDefaultSettings();

    assert.deepEqual(script.validateSettings(null), defaults);
    assert.deepEqual(script.validateSettings(undefined), defaults);
    assert.deepEqual(script.validateSettings([]), defaults);
    assert.deepEqual(script.validateSettings('x'), defaults);
    assert.deepEqual(script.validateSettings(42), defaults);
});

test('applyEventThresholds: progi per typ eventu', () => {
    const settings = {
        attackThreshold: 3,
        raidThreshold: 2,
        normalMax: 2,
        highMax: 5
    };

    const events = [
        { eventType: 'attack', addedAttackCount: 3, addedRaidCount: 0 },
        { eventType: 'attack', addedAttackCount: 2, addedRaidCount: 0 },
        { eventType: 'raid', addedAttackCount: 0, addedRaidCount: 2 },
        { eventType: 'raid', addedAttackCount: 0, addedRaidCount: 1 },
        { eventType: 'mixed', addedAttackCount: 1, addedRaidCount: 2 },
        { eventType: 'mixed', addedAttackCount: 0, addedRaidCount: 0 },
        null
    ];

    const kept = script.applyEventThresholds(events, settings);

    assert.equal(kept.length, 3);
    assert.equal(kept[0].eventType, 'attack');
    assert.equal(kept[1].eventType, 'raid');
    assert.equal(kept[2].eventType, 'mixed');
});

test('applyEventThresholds: zepsute ustawienia nie wyłączają progu', () => {
    const events = [
        { eventType: 'attack', addedAttackCount: 1 }
    ];

    assert.equal(
        script.applyEventThresholds(events, null).length,
        1
    );
    assert.deepEqual(script.applyEventThresholds(null, {}), []);
});

test('classifyPriority: bandy normal/high/critical', () => {
    const settings = script.getDefaultSettings(); // normalMax 2, highMax 5

    assert.equal(
        script.classifyPriority({ addedAttackCount: 1 }, settings),
        'normal'
    );
    assert.equal(
        script.classifyPriority({ addedAttackCount: 2 }, settings),
        'normal'
    );
    assert.equal(
        script.classifyPriority({ addedRaidCount: 3 }, settings),
        'high'
    );
    assert.equal(
        script.classifyPriority({ addedAttackCount: 5 }, settings),
        'high'
    );
    assert.equal(
        script.classifyPriority({ addedAttackCount: 6 }, settings),
        'critical'
    );
    assert.equal(script.classifyPriority({}, settings), 'normal');
    assert.equal(script.classifyPriority(null, settings), 'normal');
});

test('resolveEventPriority: jawny priorytet ma pierwszeństwo', () => {
    const settings = script.getDefaultSettings();

    assert.equal(
        script.resolveEventPriority(
            { priority: 'critical', addedAttackCount: 1 },
            settings
        ),
        'critical'
    );
    assert.equal(
        script.resolveEventPriority(
            { addedAttackCount: 6 },
            settings
        ),
        'critical'
    );
});

test('highestBatchPriority / batchPriorityColor / priorityLabel', () => {
    const settings = script.getDefaultSettings();

    assert.equal(
        script.highestBatchPriority([], settings),
        'normal'
    );
    assert.equal(
        script.highestBatchPriority(
            [
                { addedAttackCount: 1 },
                { addedAttackCount: 6 }
            ],
            settings
        ),
        'critical'
    );
    assert.equal(
        script.batchPriorityColor(
            [{ addedAttackCount: 1 }],
            settings
        ),
        script.PRIORITY_COLORS.normal
    );
    assert.equal(script.priorityLabel('high'), 'High');
    assert.equal(script.priorityLabel('critical'), 'Critical');
    assert.equal(script.priorityLabel('whatever'), 'Normal');
});

// ---------------------------------------------------------------------------
// Mapowania / role
// ---------------------------------------------------------------------------

test('extractPlayerId: formy URL profili', () => {
    assert.equal(
        script.extractPlayerId('https://cw.x2.international.travian.com/profile/385'),
        '385'
    );
    assert.equal(script.extractPlayerId('/player/385'), '385');
    assert.equal(
        script.extractPlayerId('https://x.travian.com/spieler.php?uid=385'),
        '385'
    );
    assert.equal(script.extractPlayerId('?uid=385'), '385');
    assert.equal(
        script.extractPlayerId('https://x.travian.com/a?uid=385&x=1'),
        '385'
    );
    // Priorytet formy ścieżkowej nad uid=
    assert.equal(
        script.extractPlayerId('https://x.travian.com/profile/111?uid=222'),
        '111'
    );
});

test('extractPlayerId: odrzucane wejścia', () => {
    assert.equal(script.extractPlayerId(''), null);
    assert.equal(script.extractPlayerId(null), null);
    assert.equal(script.extractPlayerId(385), null);
    assert.equal(script.extractPlayerId('abc'), null);
    assert.equal(
        script.extractPlayerId('https://cw.x2.international.travian.com/alliance/'),
        null
    );
    assert.equal(
        script.extractPlayerId('https://x.travian.com/alliance/members'),
        null
    );
});

test('buildMappingKey: hostname znormalizowany do małych liter', () => {
    assert.equal(
        script.buildMappingKey('CW.X2.INTERNATIONAL.TRAVIAN.COM', '385'),
        'cw.x2.international.travian.com:385'
    );
    assert.equal(
        script.buildMappingKey(HOST, '385'),
        'cw.x2.international.travian.com:385'
    );
});

test('validateDiscordUserId / validateDiscordRoleId', () => {
    assert.equal(script.validateDiscordUserId(UID_A), UID_A);
    assert.equal(script.validateDiscordUserId(' 123456789012345678 '), UID_A);
    assert.equal(script.validateDiscordUserId(`<@${UID_A}>`), null);
    assert.equal(script.validateDiscordUserId(`<@&${UID_A}>`), null);
    assert.equal(script.validateDiscordUserId('1234567890123456'), null);
    assert.equal(script.validateDiscordUserId('123456789012345678901'), null);
    assert.equal(script.validateDiscordUserId('abc'), null);
    assert.equal(script.validateDiscordUserId(UID_A), UID_A); // rola: identyczna walidacja
});

test('normalizeProfileInput: ID i URL-e', () => {
    assert.equal(script.normalizeProfileInput('385'), '385');
    assert.equal(script.normalizeProfileInput(' 385 '), '385');
    assert.equal(
        script.normalizeProfileInput('https://cw.x2.international.travian.com/profile/385'),
        '385'
    );
    assert.equal(script.normalizeProfileInput('/player/385'), '385');
    assert.equal(script.normalizeProfileInput('spieler.php?uid=385'), '385');
    assert.equal(script.normalizeProfileInput(''), null);
    assert.equal(script.normalizeProfileInput('abc'), null);
    assert.equal(script.normalizeProfileInput(385), null);
});

test('addMapping: dodawanie, deduplikacja, walidacja', () => {
    const result = script.addMapping(
        {},
        HOST,
        '385',
        `${UID_A}, ${UID_B}, ${UID_A}, <@${UID_A}>, abc`
    );

    assert.deepEqual(result.validIds, [UID_A, UID_B]);
    assert.deepEqual(result.invalidIds, [`<@${UID_A}>`, 'abc']);
    assert.deepEqual(result.mappings[HOST], { '385': [UID_A, UID_B] });
});

test('addMapping: mergowanie z istniejącymi i string vs tablica', () => {
    const existing = {
        [HOST]: { '385': [UID_A] }
    };

    const fromArray = script.addMapping(existing, HOST, '385', [UID_B]);
    assert.deepEqual(fromArray.mappings[HOST]['385'], [UID_A, UID_B]);
    assert.deepEqual(fromArray.validIds, [UID_A, UID_B]);

    const noValid = script.addMapping(existing, HOST, '999', 'niepoprawne');
    assert.deepEqual(noValid.validIds, []);
    assert.equal(noValid.mappings[HOST]['999'], undefined);
});

test('addMapping: nie mutuje wejścia', () => {
    const input = {};

    script.addMapping(input, HOST, '385', UID_A);

    assert.deepEqual(input, {});
});

test('removeMapping: bez discordId usuwa cały wpis profilu', () => {
    const mappings = {
        [HOST]: { '385': [UID_A, UID_B], '999': [UID_B] }
    };

    const next = script.removeMapping(mappings, HOST, '385');

    assert.deepEqual(next[HOST], { '999': [UID_B] });
    assert.deepEqual(mappings[HOST], { '385': [UID_A, UID_B], '999': [UID_B] });
});

test('removeMapping: pojedynczy odbiorca', () => {
    const mappings = {
        [HOST]: { '385': [UID_A, UID_B] }
    };

    const next = script.removeMapping(mappings, HOST, '385', UID_A);

    assert.deepEqual(next[HOST]['385'], [UID_B]);

    // Ostatni odbiorca -> wpis znika
    const last = script.removeMapping(next, HOST, '385', UID_B);
    assert.equal(last[HOST]['385'], undefined);
});

test('removeMapping: nieznane ID nie zmienia niczego', () => {
    const mappings = {
        [HOST]: { '385': [UID_A] }
    };

    const next = script.removeMapping(
        mappings,
        HOST,
        '385',
        '000000000000000000'
    );

    assert.equal(next, mappings); // ta sama referencja
});

test('listMappings: czytelne podsumowanie', () => {
    const mappings = {
        [HOST]: {
            '385': [UID_A, UID_B],
            '999': [UID_B],
            'puste': []
        }
    };

    assert.deepEqual(script.listMappings(mappings, HOST), [
        '385 → 123456789012345678, 234567890123456789',
        '999 → 234567890123456789'
    ]);
    assert.deepEqual(script.listMappings({}, HOST), []);
});

test('setAlertRoleId / clearAlertRoleId', () => {
    assert.deepEqual(
        script.setAlertRoleId({}, ROLE),
        { roleId: ROLE }
    );
    assert.deepEqual(
        script.setAlertRoleId({ foo: 1 }, ROLE),
        { foo: 1, roleId: ROLE }
    );

    const config = { foo: 1, roleId: ROLE };
    const invalid = script.setAlertRoleId(config, 'bad');

    assert.equal(invalid, config); // niepoprawne -> bez zmian, ta sama referencja
    assert.deepEqual(
        script.clearAlertRoleId({ roleId: ROLE }),
        { roleId: null }
    );
});

test('setLeaveRoleId / clearLeaveRoleId: immutable validation', () => {
    const config = { roleId: ROLE, leaveRoleId: null };
    assert.deepEqual(script.setLeaveRoleId(config, ROLE), { roleId: ROLE, leaveRoleId: ROLE });
    assert.equal(script.setLeaveRoleId(config, `<@&${ROLE}>`), config);
    assert.equal(script.setLeaveRoleId(config, '1234567890123456'), config);
    assert.equal(script.setLeaveRoleId(config, 123456789012345678), config);
    assert.deepEqual(script.clearLeaveRoleId(config), { roleId: ROLE, leaveRoleId: null });
    assert.deepEqual(config, { roleId: ROLE, leaveRoleId: null });
});

test('loadDiscordConfig: normalizes legacy, corrupt, and invalid fields', () => {
    withLocalStorage({ travianAllianceDiscordConfig_v1: JSON.stringify({ roleId: ROLE }) }, () => {
        assert.deepEqual(script.loadDiscordConfig(), { roleId: ROLE, leaveRoleId: null });
    });
    withLocalStorage({ travianAllianceDiscordConfig_v1: JSON.stringify({ roleId: ROLE, leaveRoleId: `<@&${ROLE}>` }) }, () => {
        assert.deepEqual(script.loadDiscordConfig(), { roleId: ROLE, leaveRoleId: null });
    });
    withLocalStorage({ travianAllianceDiscordConfig_v1: '{broken' }, () => {
        assert.deepEqual(script.loadDiscordConfig(), { roleId: null, leaveRoleId: null });
    });
});

test('loadMappings provenance: distinguishes absent, malformed, empty, current, and other-world mappings', () => {
    assert.equal(script.inspectMappingStorage(null, HOST).status, 'absent');
    assert.equal(script.inspectMappingStorage('{broken', HOST).status, 'malformed');
    assert.equal(script.inspectMappingStorage('{}', HOST).status, 'empty');
    const current = script.inspectMappingStorage(JSON.stringify({
        [HOST]: { '385': [UID_A], '386': [UID_B] }
    }), HOST);
    assert.deepEqual(current, { status: 'current', currentEntries: 2, otherHostEntries: 0, otherHostBuckets: 0 });
    const foreign = script.inspectMappingStorage(JSON.stringify({
        'other.example': { '385': [UID_A] },
        'OTHER.EXAMPLE.': { '386': [UID_B] }
    }), HOST);
    assert.equal(foreign.status, 'other-host');
    assert.equal(foreign.currentEntries, 0);
    assert.equal(foreign.otherHostEntries, 2);
    assert.equal(foreign.otherHostBuckets, 1);
});

test('loadDiscordConfig provenance: role states are read-only and retain usable existing values', () => {
    assert.equal(script.inspectDiscordConfigStorage(null).status, 'absent');
    assert.equal(script.inspectDiscordConfigStorage('{broken').status, 'malformed');
    assert.equal(script.inspectDiscordConfigStorage('{}').status, 'empty');
    const emptyText = script.storageProvenanceText({ discord: script.inspectDiscordConfigStorage('{}') }).join(' ');
    assert.match(emptyText, /empty/);
    assert.doesNotMatch(emptyText, new RegExp(ROLE));
    const invalid = script.inspectDiscordConfigStorage(JSON.stringify({ roleId: 'bad', leaveRoleId: '<@&' + ROLE + '>' }));
    assert.deepEqual(invalid, { status: 'invalid', validFields: 0, invalidFields: 2 });
    const valid = script.inspectDiscordConfigStorage(JSON.stringify({ roleId: ROLE, leaveRoleId: UID_A }));
    assert.deepEqual(valid, { status: 'valid', validFields: 2, invalidFields: 0 });
    withLocalStorage({ travianAllianceDiscordConfig_v1: JSON.stringify({ roleId: ROLE, leaveRoleId: UID_A }) }, map => {
        const before = map.travianAllianceDiscordConfig_v1;
        assert.deepEqual(script.loadDiscordConfig(), { roleId: ROLE, leaveRoleId: UID_A });
        assert.deepEqual(script.loadDiscordConfigProvenance(), { status: 'valid', validFields: 2, invalidFields: 0 });
        assert.equal(map.travianAllianceDiscordConfig_v1, before);
    });
});

test('Players workspace / Discord config provenance: actionable text exposes states/counts but never Discord IDs or writes', () => {
    withLocalStorage({
        travianAlliancePlayerMappings_v1: JSON.stringify({ 'other.example': { '385': [UID_A] } }),
        travianAllianceDiscordConfig_v1: JSON.stringify({ roleId: 'bad', leaveRoleId: ROLE })
    }, map => {
        const before = JSON.stringify(Object.fromEntries(Object.entries(map)));
        const model = script.buildStorageProvenanceModel(HOST);
        const text = script.storageProvenanceText(model).join(' ');
        assert.match(text, /other-world data/);
        assert.match(text, /invalid/);
        assert.doesNotMatch(text, new RegExp(UID_A));
        assert.doesNotMatch(text, new RegExp(ROLE));
        assert.equal(JSON.stringify(Object.fromEntries(Object.entries(map))), before);
    });
    const absent = script.storageProvenanceText(script.buildStorageProvenanceModel(HOST, {})).join(' ');
    assert.match(absent, /mapping data not found/);
    assert.match(absent, /role configuration not found/);
});

test('saveDiscordConfig: valid roundtrip and invalid input do not mutate storage', () => {
    withLocalStorage({ travianAllianceDiscordConfig_v1: JSON.stringify({ roleId: ROLE }) }, map => {
        const valid = { roleId: ROLE, leaveRoleId: UID_A };
        assert.equal(script.saveDiscordConfig(valid).ok, true);
        assert.deepEqual(JSON.parse(map.travianAllianceDiscordConfig_v1), valid);
        const before = map.travianAllianceDiscordConfig_v1;
        assert.equal(script.saveDiscordConfig({ roleId: ROLE, leaveRoleId: `<@&${UID_A}>` }).ok, false);
        assert.equal(map.travianAllianceDiscordConfig_v1, before);
    });
});

// ---------------------------------------------------------------------------
// Wyciszenia (mute)
// ---------------------------------------------------------------------------

test('addMutedPlayer: dodawanie bez mutacji', () => {
    const mutes = {};
    const next = script.addMutedPlayer(mutes, HOST, '385');

    assert.deepEqual(next, { [HOST]: { '385': true } });
    assert.deepEqual(mutes, {});

    assert.equal(script.addMutedPlayer(mutes, HOST, 385), mutes);
    assert.equal(script.addMutedPlayer(mutes, HOST, ''), mutes);
});

test('removeMutedPlayer: usuwanie i sprzątanie świata', () => {
    const mutes = {
        [HOST]: { '385': true, '999': true },
        'inny.swiat': { '111': true }
    };

    const step1 = script.removeMutedPlayer(mutes, HOST, '385');
    assert.deepEqual(step1[HOST], { '999': true });

    const step2 = script.removeMutedPlayer(step1, HOST, '999');
    assert.equal(step2[HOST], undefined); // pusty świat znika
    assert.deepEqual(step2['inny.swiat'], { '111': true });
});

test('isPlayerMuted / listMutedPlayers', () => {
    const mutes = {
        [HOST]: { '385': true, '999': true }
    };

    assert.equal(script.isPlayerMuted(mutes, HOST, '385'), true);
    assert.equal(script.isPlayerMuted(mutes, HOST, '999'), true);
    assert.equal(script.isPlayerMuted(mutes, HOST, '111'), false);
    assert.equal(script.isPlayerMuted(mutes, 'CW.X2.INTERNATIONAL.TRAVIAN.COM', '385'), true);
    assert.equal(script.isPlayerMuted(mutes, 'inny.swiat', '385'), false);
    assert.equal(script.isPlayerMuted({}, HOST, '385'), false);
    assert.equal(script.isPlayerMuted(mutes, HOST, ''), false);

    assert.deepEqual(script.listMutedPlayers(mutes, HOST), ['385', '999']);
    assert.deepEqual(script.listMutedPlayers({}, HOST), []);
});

test('filterMutedEvents: tylko gracze z ID mogą być wyciszeni', () => {
    const events = [
        { name: 'Muted', url: `https://x.travian.com/profile/385` },
        { name: 'Kept', url: `https://x.travian.com/profile/999` },
        { name: 'NoId', url: `https://x.travian.com/alliance/members` }
    ];
    const mutes = { [HOST]: { '385': true } };

    const filtered = script.filterMutedEvents(events, HOST, mutes);

    assert.deepEqual(filtered.map(e => e.name), ['Kept', 'NoId']);
    assert.deepEqual(script.filterMutedEvents(null, HOST, mutes), []);
});

// ---------------------------------------------------------------------------
// Kolejka FIFO / chunkowanie
// ---------------------------------------------------------------------------

function makeEvent(name, url) {
    return {
        name,
        url,
        attackCount: 1,
        raidCount: 0,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack',
        priority: 'high', // nie powinno przejść do pending eventa
        thresholdPass: true
    };
}

test('enqueueEvents: FIFO i snapshot płaski (bez metadanych)', () => {
    const batch = script.enqueueEvents(
        {},
        HOST,
        [
            makeEvent('A', '/profile/1'),
            makeEvent('B', '/profile/2'),
            makeEvent('C', '/profile/3')
        ]
    );

    const world = batch[HOST];

    assert.equal(world.events.length, 3);
    assert.deepEqual(
        world.events.map(e => e.name),
        ['A', 'B', 'C']
    );

    // PendingEvent to płaski snapshot — bez priority/thresholdPass
    assert.equal('priority' in world.events[0], false);
    assert.equal('thresholdPass' in world.events[0], false);
    assert.equal(world.events[0].addedAttackCount, 1);
    assert.equal(world.events[0].url, '/profile/1');
});

test('enqueueEvents: zachowuje createdAt i attemptCount', () => {
    const existing = {
        [HOST]: {
            events: [],
            createdAt: 111,
            attemptCount: 2
        }
    };

    const next = script.enqueueEvents(existing, HOST, [makeEvent('A', '/p/1')]);

    assert.equal(next[HOST].createdAt, 111);
    assert.equal(next[HOST].attemptCount, 2);
});

test('enqueueEvents: cap QUEUE_MAX_EVENTS odcina najstarsze', () => {
    const events = [];

    for (let i = 0; i < script.QUEUE_MAX_EVENTS + 10; i += 1) {
        events.push(makeEvent(`P${i}`, `/profile/${i}`));
    }

    const batch = script.enqueueEvents({}, HOST, events);
    const names = batch[HOST].events.map(e => e.name);

    assert.equal(batch[HOST].events.length, script.QUEUE_MAX_EVENTS);
    assert.equal(names[0], 'P10'); // najstarsze (P0..P9) odpadły
    assert.equal(names[names.length - 1], `P${script.QUEUE_MAX_EVENTS + 9}`);
});

test('enqueueEvents: cap raportuje liczbe i tekstowy powod overflow', () => {
    const events = Array.from({ length: 51 }, (_, index) => makeEvent(`P${index}`, `/profile/${index}`));
    const batch = script.enqueueEvents({}, HOST, events);
    assert.equal(batch[HOST].events.length, script.QUEUE_MAX_EVENTS);
    assert.equal(batch[HOST].overflowCount, 1);
    assert.equal(batch[HOST].overflowReason, 'queue-cap');
    assert.match(batch[HOST].overflowMessage, /bounded|overflow|queue/i);
});

test('enqueueEvents: nie-tablica nie tworzy kolejki', () => {
    const batch = { [HOST]: { events: [], createdAt: 1, attemptCount: 0 } };

    assert.equal(script.enqueueEvents(batch, HOST, null), batch);
    assert.deepEqual(script.enqueueEvents(null, HOST, null), {});
});

test('snapshotBatch: kopia kolejki albo null', () => {
    const batch = {
        [HOST]: {
            events: [makeEvent('A', '/p/1')],
            createdAt: 5,
            attemptCount: 1
        }
    };

    const snap = script.snapshotBatch(batch, HOST);

    assert.equal(snap.events.length, 1);
    assert.equal(snap.createdAt, 5);
    assert.equal(snap.attemptCount, 1);
    assert.notEqual(snap.events, batch[HOST].events); // kopia, nie referencja

    assert.equal(
        script.snapshotBatch({ [HOST]: { events: [] } }, HOST),
        null
    );
    assert.equal(script.snapshotBatch({}, HOST), null);
    assert.equal(script.snapshotBatch(null, HOST), null);
});

test('chunkEvents: dzielenie FIFO z domyślnym i własnym rozmiarem', () => {
    const events = [];

    for (let i = 0; i < 25; i += 1) {
        events.push(makeEvent(`E${i}`, `/profile/${i}`));
    }

    const chunks = script.chunkEvents(events, 20);

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 20);
    assert.equal(chunks[1].length, 5);
    assert.equal(chunks[0][0].name, 'E0');
    assert.equal(chunks[1][0].name, 'E20');

    const small = script.chunkEvents(events, 3);
    assert.deepEqual(small.map(c => c.length), [3, 3, 3, 3, 3, 3, 3, 3, 1]);

    assert.deepEqual(script.chunkEvents([], 20), []);
    assert.deepEqual(script.chunkEvents(null, 20), []);
    // maxSize < 1 lub brak -> domyślny PAYLOAD_CHUNK_MAX (20)
    assert.deepEqual(
        script.chunkEvents(events, 0),
        [events.slice(0, 20), events.slice(20)]
    );
    assert.deepEqual(
        script.chunkEvents(events, undefined),
        [events.slice(0, 20), events.slice(20)]
    );
});

test('clearBatchEvents: opróżnia kolej, resetuje createdAt', () => {
    const batch = {
        [HOST]: {
            events: [makeEvent('A', '/p/1')],
            createdAt: 1,
            attemptCount: 3
        }
    };

    const next = script.clearBatchEvents(batch, HOST);

    assert.deepEqual(next[HOST].events, []);
    assert.equal(next[HOST].attemptCount, 3); // własność retry zachowana
    assert.equal(typeof next[HOST].createdAt, 'number');
    assert.equal(next[HOST].createdAt >= 1, true);
});

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

test('buildMentionContent: rola pierwsza, użytkownicy zdeduplikowani', () => {
    assert.equal(
        script.buildMentionContent(ROLE, [UID_A, UID_B, UID_A]),
        `<@&${ROLE}> <@${UID_A}> <@${UID_B}>`
    );
    assert.equal(script.buildMentionContent(null, [UID_A, UID_B]), `<@${UID_A}> <@${UID_B}>`);
    assert.equal(script.buildMentionContent(ROLE, []), `<@&${ROLE}>`);
    assert.equal(script.buildMentionContent(null, []), '');
    assert.equal(script.buildMentionContent(null, null), '');
});

test('buildAllowedMentions: jawna biała lista bez parse', () => {
    assert.deepEqual(
        script.buildAllowedMentions(ROLE, [UID_A, UID_B, UID_A]),
        { users: [UID_A, UID_B], roles: [ROLE] }
    );
    assert.deepEqual(
        script.buildAllowedMentions(null, [UID_A]),
        { users: [UID_A] }
    );
    assert.equal('roles' in script.buildAllowedMentions(null, []), false);
    assert.equal('parse' in script.buildAllowedMentions(ROLE, []), false);
});

// ---------------------------------------------------------------------------
// Historia
// ---------------------------------------------------------------------------

test('buildHistoryRecord: pola, muted, thresholdBlocked', () => {
    const mutes = { [HOST]: { '385': true } };

    const record = script.buildHistoryRecord(
        {
            name: 'Alice',
            url: `https://x.travian.com/profile/385`,
            attackCount: 2,
            raidCount: 1,
            addedAttackCount: 1,
            addedRaidCount: 1,
            eventType: 'mixed',
            priority: 'high',
            thresholdPass: false
        },
        HOST,
        1700000000000,
        mutes
    );

    assert.deepEqual(record, {
        detectedAtMs: 1700000000000,
        name: 'Alice',
        url: 'https://x.travian.com/profile/385',
        playerId: '385',
        attackCount: 2,
        raidCount: 1,
        addedAttackCount: 1,
        addedRaidCount: 1,
        eventType: 'mixed',
        priority: 'high',
        muted: true,
        thresholdBlocked: true
    });
});

test('recordHistory: najnowszy na początku, cap 500', () => {
    let history = {};
    const now = 1700000000000;

    for (let i = 0; i < script.HISTORY_MAX_EVENTS + 20; i += 1) {
        history = script.recordHistory(
            history,
            HOST,
            { detectedAtMs: now + i, name: `P${i}` }
        );
    }

    const events = history[HOST].events;

    assert.equal(events.length, script.HISTORY_MAX_EVENTS);
    assert.equal(events[0].name, `P${script.HISTORY_MAX_EVENTS + 19}`); // najnowszy
    assert.equal(events[events.length - 1].name, 'P20'); // najstarszy z zachowanych
});

test('aggregateHistory: sumy, okno 24h, gracze', () => {
    const now = 1700000000000;
    const hourMs = 60 * 60 * 1000;

    const summary = script.aggregateHistory(
        [
            {
                detectedAtMs: now - hourMs, // w oknie 24h
                eventType: 'attack',
                addedAttackCount: 2,
                addedRaidCount: 0,
                name: 'Alice',
                muted: false,
                thresholdBlocked: false
            },
            {
                detectedAtMs: now - 2 * 24 * hourMs, // poza oknem
                eventType: 'mixed',
                addedAttackCount: 1,
                addedRaidCount: 3,
                name: 'Bob',
                muted: true,
                thresholdBlocked: true
            },
            {
                detectedAtMs: now - 30 * 60 * 1000,
                eventType: 'attack',
                addedAttackCount: 1,
                addedRaidCount: 0,
                name: 'Alice',
                muted: false,
                thresholdBlocked: false
            }
        ],
        now
    );

    assert.equal(summary.total, 3);
    assert.equal(summary.attacks, 2);
    assert.equal(summary.mixed, 1);
    assert.equal(summary.attackDelta, 4);
    assert.equal(summary.raidDelta, 3);
    assert.equal(summary.playerCount, 2);
    assert.equal(summary.muted, 1);
    assert.equal(summary.thresholdBlocked, 1);
    assert.equal(summary.last24h.total, 2);
    assert.equal(summary.last24h.playerCount, 1);
    assert.equal(summary.last24h.attackDelta, 3);
});

test('count reconciliation equals envelope and latest correlated terminal', () => {
    const envelope = { generation: 9, pending: [{ sourceEventIds: ['s1'] }], inFlight: [], failed: [], uncertain: [], metrics: { activeTotals: { players: 1, attacks: 8, raids: 0 }, newNetDeltas: { players: 1, attacks: 8, raids: 0 }, dispositions: { muted: 0, blocked: 0, eligible: 8 }, deliveryAccounting: { terminal: [{ sourceEventIds: ['s1'] }] } } };
    const model = script.buildCountReconciliationPanelModel({ routeRole: 'canonical-member', leaseGeneration: 4, envelope, traces: [
        { sequence: 1, scanId: 'scan-old', stage: 'snapshot', status: 'ok', reason: 'authoritative' },
        { sequence: 2, scanId: 'scan-old', stage: 'onScanComplete', status: 'ok' },
        { sequence: 3, scanId: 'scan-new', stage: 'snapshot', status: 'rejected', reason: 'readiness-timeout' },
        { sequence: 4, scanId: 'scan-new', stage: 'onReadinessCommit', status: 'ok' }
    ] });
    assert.deepEqual(model.activeTotals, { players: 1, attacks: 8, raids: 0 });
    assert.deepEqual(model.newNetDeltas, { players: 1, attacks: 8, raids: 0, sampled: true });
    assert.deepEqual(model.deliveryTotals, { pending: 1, inFlight: 0, failed: 0, uncertain: 0, acknowledged: 1 });
    assert.equal(model.scanId, script.diagnosticDigest ? script.diagnosticDigest('scan-new') : model.scanId);
    assert.equal(model.scanReason, 'readiness-timeout');
    assert.equal(model.scanOutcome, 'rejected');
    assert.equal(model.scanLabel, 'readiness-timeout/rejected');
});

test('latest generic hook cannot mask a scan terminal and later terminal supersedes earlier terminal', () => {
    const traces = [
        { sequence: 1, scanId: 'scan-1', stage: 'snapshot', status: 'ok', reason: 'authoritative' },
        { sequence: 2, scanId: 'scan-1', stage: 'onScanComplete', status: 'ok' },
        { sequence: 3, scanId: 'scan-2', stage: 'snapshot', status: 'error', reason: 'fence-before-monitor-commit' },
        { sequence: 4, scanId: 'scan-2', stage: 'onPanelRender', status: 'ok' }
    ];
    assert.equal(script.selectLatestScanTerminalRecord(traces).scanId, 'scan-2');
    assert.equal(script.buildCountReconciliationPanelModel({ traces }).scanReason, 'fence-before-monitor-commit');
});

test('terminal labels are explicit and bounded', () => {
    assert.equal(script.describeScanTerminal({ stage: 'snapshot', status: 'ok', reason: 'authoritative' }), 'accepted/authoritative');
    assert.equal(script.describeScanTerminal({ stage: 'snapshot', status: 'rejected', reason: 'malformed-count' }), 'parser-rejected/malformed-count');
    assert.equal(script.describeScanTerminal({ stage: 'lease', status: 'rejected', reason: 'lease-lost-before-scan' }), 'lease-lost/rejected');
    assert.equal(script.describeScanTerminal({ stage: 'snapshot', status: 'error', reason: 'fence-before-monitor-commit' }), 'fence-storage-error/fence-before-monitor-commit');
    assert.equal(script.describeScanTerminal({ stage: 'reload', status: 'rejected', reason: 'reload-blocked' }), 'reload-blocked/rejected');
});

test('+8 for one player is displayed separately from player count', () => {
    const model = script.buildCountReconciliationPanelModel({ envelope: { generation: 1, pending: [], inFlight: [], failed: [], uncertain: [], metrics: { activeTotals: { players: 1, attacks: 8, raids: 0 }, newNetDeltas: { players: 1, attacks: 8, raids: 0 } } } });
    assert.equal(model.newNetDeltas.players, 1);
    assert.equal(model.newNetDeltas.attacks, 8);
});

test('coalesced multi-request records retain represented totals', () => {
    const model = script.buildCountReconciliationPanelModel({ envelope: { pending: [{ sourceEventIds: ['a', 'b'] }], inFlight: [{ sourceEventIds: ['c'] }], failed: [], uncertain: [], metrics: {} } });
    assert.equal(model.deliveryTotals.pending, 2);
    assert.equal(model.deliveryTotals.inFlight, 1);
});

test('rejected scan reason is visible and trace filters are bounded', () => {
    const traces = Array.from({ length: 40 }, (_, index) => ({ sequence: index, scanId: 'reject', stage: 'snapshot', status: 'rejected', reason: 'table-rejected' }));
    const filtered = script.boundedDiagnosticRecords(traces, { scanId: 'reject', stage: 'snapshot', outcome: 'rejected' });
    const model = script.buildCountReconciliationPanelModel({ diagnostics: { scanReason: 'table-rejected' }, traces });
    assert.equal(filtered.length, 32);
    assert.equal(model.scanReason, 'table-rejected');
});

test('incident export is bounded, redacted, and links stages by scan ID', () => {
    const bundle = script.buildIncidentBundle({ routeRole: 'canonical-member', traces: [{ sequence: 1, scanId: 'scan-10', stage: 'route', status: 'ok' }, { sequence: 2, scanId: 'scan-10', stage: 'dispatch', status: 'acknowledged' }], envelope: { pending: [], inFlight: [], failed: [], uncertain: [], metrics: {} }, webhookConfigured: true });
    const serialized = JSON.stringify(bundle);
    assert.ok(Buffer.byteLength(serialized) <= 512 * 1024);
    assert.equal(bundle.recentTraces[0].scanId, bundle.recentTraces[1].scanId);
    assert.equal(/webhook|token|payload|playerName|profile\//i.test(serialized), false);
    assert.deepEqual(bundle.labels, { players: 'players', messages: 'messages', attacks: 'attacks', raids: 'raids', net: 'net, sampled' });
});

test('bounded incident and settings exports carry a redacted textual reason', () => {
    const traces = Array.from({ length: 32 }, (_, index) => ({ sequence: index, stage: 'route', status: 'error', reason: 'x'.repeat(20 * 1024) }));
    const incident = script.buildIncidentBundle({ traces, diagnostics: {}, envelope: {}, routeRole: 'canonical-member' });
    assert.equal(incident.bounded, true);
    assert.match(incident.boundedMessage, /512 KiB|bounded|omitted/i);
    assert.equal(/profile\/|webhook|token|payload/i.test(JSON.stringify(incident)), false);

    const storage = { getItem: key => key === 'travianAlliancePlayerMappings_v1' ? JSON.stringify({ [HOST]: { '1': ['1'.repeat(600 * 1024)] } }) : null };
    const settings = script.buildSettingsBackup({ hostname: HOST, storage, webhook: '' });
    assert.equal(settings.bounded, true);
    assert.match(settings.boundedMessage, /512 KiB|bounded|omitted/i);
    assert.equal(/webhook|token|secret|payload/i.test(JSON.stringify(settings)), false);
});

// ---------------------------------------------------------------------------
// Storage bez localStorage / GM (bezpieczne no-opy)
// ---------------------------------------------------------------------------

test('Players workspace model: union, facts, names and counts', () => {
    const input = {
        roster: [
            { id: '2', name: 'Cached two' },
            { id: '1', name: 'Alpha' },
            { id: '2', name: 'Live two' }
        ],
        mappings: { '1': [' 123 ', '', '123', 456], '9': ['789'] },
        muted: ['2', '8'],
        cachedNames: { '2': 'Cached name', '8': 'Orphan mute' },
        liveNames: { '2': 'Live name', '9': 'Mapped orphan' }
    };
    const frozen = deepFreeze(input);
    const model = script.buildPlayerWorkspaceModel(frozen);

    assert.deepEqual(model.rows, [
        { id: '1', name: 'Alpha', present: true, mapped: true, muted: false, orphaned: false, recipients: ['123'] },
        { id: '2', name: 'Live name', present: true, mapped: false, muted: true, orphaned: false, recipients: [] },
        { id: '9', name: 'Mapped orphan', present: false, mapped: true, muted: false, orphaned: true, recipients: ['789'] },
        { id: '8', name: 'Orphan mute', present: false, mapped: false, muted: true, orphaned: true, recipients: [] }
    ]);
    assert.deepEqual(model.summary, { monitored: 2, mapped: 2, unmapped: 0, muted: 2, orphaned: 2 });
    assert.deepEqual(input, frozen);
});

test('Players workspace read model: rejected live parse uses the accepted roster cache', () => {
    const model = script.buildPlayerWorkspaceReadModel({
        hostname: HOST,
        snapshot: { status: 'rejected', reason: 'missing-player-id', membersById: {} },
        cachedRoster: {
            '900001': { name: 'Cached Alpha', url: '/profile/900001' },
            '900002': { name: 'Cached Beta', url: '/profile/900002' }
        },
        mappings: { '900003': ['123'] },
        muted: ['900004']
    });
    assert.equal(model.rosterSource, 'cache');
    assert.equal(model.rosterStatus, 'cached');
    assert.equal(model.rosterStatusText, 'Live roster unavailable — showing last accepted roster (2 players). Reason: missing-player-id');
    assert.deepEqual(model.rows.map((row) => row.id), ['900001', '900002', '900003', '900004']);
    assert.equal(model.rows.find((row) => row.id === '900003').orphaned, true);
    assert.equal(model.rows.find((row) => row.id === '900004').muted, true);
});

test('Players workspace read model: authoritative DOM wins over stale cache', () => {
    const model = script.buildPlayerWorkspaceReadModel({
        snapshot: {
            status: 'authoritative',
            membersById: { '1': { name: 'Fresh Alpha', url: '/profile/1' } }
        },
        cachedRoster: { '1': { name: 'Stale Alpha' }, '2': { name: 'Stale Beta' } }
    });
    assert.equal(model.rosterSource, 'live');
    assert.equal(model.rosterStatus, 'authoritative');
    assert.deepEqual(model.rows.map((row) => row.id), ['1']);
    assert.equal(model.rows[0].name, 'Fresh Alpha');
});

test('Players workspace fixture: rejected browser DOM gets a labelled cached roster', async () => {
    const rejected = await acquisitionBrowser.extractRejectedFixtureSnapshots(['missing-player-id']);
    const model = script.buildPlayerWorkspaceReadModel({
        snapshot: rejected['missing-player-id'].snapshot,
        cachedRoster: { '900001': { name: 'Fixture cached player' } }
    });
    assert.equal(rejected['missing-player-id'].snapshot.status, 'rejected');
    assert.equal(model.rosterStatusText, 'Live roster unavailable — showing last accepted roster (1 players). Reason: missing-player-id');
    assert.equal(model.rows[0].name, 'Fixture cached player');
});

test('Players workspace read model: rejected parse without cache is explicit and does not write', () => {
    let writes = 0;
    withLocalStorage({ [ROSTER_KEY]: '{invalid json' }, () => {
        const original = global.localStorage.setItem;
        global.localStorage.setItem = () => { writes += 1; };
        try {
            const model = script.buildPlayerWorkspaceReadModel({
                snapshot: { status: 'rejected', reason: 'no-member-table', membersById: {} },
                cachedRoster: script.loadRoster()[HOST]
            });
            assert.equal(model.rosterStatus, 'empty');
            assert.equal(model.rosterStatusText, 'Live roster unavailable — no accepted roster is stored. Reason: no-member-table');
            assert.deepEqual(model.rows, []);
        } finally {
            global.localStorage.setItem = original;
        }
    });
    assert.equal(writes, 0);
});

test('Players workspace pagination: deterministic pages and actionable order', () => {
    const rows = script.buildPlayerWorkspaceModel({
        roster: Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1), name: `Player ${i + 1}` })),
        mappings: { '1': ['1'] }, muted: ['2'], cachedNames: {}, liveNames: {}
    }).rows;
    const page1 = script.paginatePlayerWorkspaceRows(rows, { page: 1 });
    const page2 = script.paginatePlayerWorkspaceRows(rows, { page: 99 });
    assert.equal(page1.pageCount, 2);
    assert.equal(page1.total, 21);
    assert.equal(page1.start, 1);
    assert.equal(page1.end, 20);
    assert.equal(page1.rows.length, 20);
    assert.equal(page2.page, 2);
    assert.equal(page2.start, 21);
    assert.equal(page2.end, 21);
    assert.equal(page2.rows.length, 1);
    assert.equal(page1.rows[0].id, '10');
});

test('Players workspace page sizes: exact counts for 1/20/21/60/120', () => {
    for (const [count, pageCount] of [[1, 1], [20, 1], [21, 2], [60, 3], [120, 6]]) {
        const rows = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: `P${i + 1}`, present: true, mapped: false, muted: false, orphaned: false, recipients: [] }));
        const result = script.paginatePlayerWorkspaceRows(rows, { page: pageCount });
        assert.equal(result.pageCount, pageCount);
        assert.equal(result.rows.length, Math.min(20, count - (pageCount - 1) * 20));
        assert.equal(result.start, (pageCount - 1) * 20 + 1);
        assert.equal(result.end, count);
    }
});

test('Players workspace facts: mapped and muted overlap is not unmapped', () => {
    const model = script.buildPlayerWorkspaceModel({ roster: ['1'], mappings: { '1': ['x'] }, muted: ['1'] });
    assert.deepEqual(model.rows[0], { id: '1', name: '1', present: true, mapped: true, muted: true, orphaned: false, recipients: ['x'] });
    assert.deepEqual(model.summary, { monitored: 1, mapped: 1, unmapped: 0, muted: 1, orphaned: 0 });
});

test('Players workspace filters: query and nonexclusive dimensions', () => {
    const rows = script.buildPlayerWorkspaceModel({
        roster: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }, { id: '3', name: 'Gamma' }],
        mappings: { '1': ['1'], '2': ['2'] }, muted: ['1', '3', '9'],
        cachedNames: { '9': 'Orphan' }, liveNames: {}
    }).rows;
    const ids = options => script.paginatePlayerWorkspaceRows(rows, options).rows.map(row => row.id);
    assert.deepEqual(ids({ mapped: true }), ['1', '2']);
    assert.deepEqual(ids({ unmapped: true }), []);
    assert.deepEqual(ids({ muted: true }), ['1', '3', '9']);
    assert.deepEqual(ids({ orphaned: true }), ['9']);
    assert.deepEqual(ids({ mapped: true, muted: true }), ['1']);
    assert.deepEqual(ids({ query: 'gAM' }), ['3']);
    assert.deepEqual(ids({ query: '9', orphaned: true }), ['9']);
});

test('Players workspace filters: all sixteen flag combinations are exact', () => {
    const rows = script.buildPlayerWorkspaceModel({
        roster: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }, { id: '3', name: 'Gamma' }, { id: '4', name: 'Delta' }],
        mappings: { '1': ['x'], '2': ['y'], '9': ['z'] }, muted: ['1', '4', '9', '8'],
        cachedNames: { '8': 'Orphan mute', '9': 'Orphan mapped' }
    }).rows;
    const expected = {
        '0000': ['3', '1', '2', '4', '9', '8'], '0001': ['9', '8'], '0010': ['1', '4', '9', '8'], '0100': ['3'],
        '0011': ['9', '8'], '0101': [], '0110': [], '0111': [], '1000': ['1', '2', '9'], '1001': ['9'],
        '1010': ['1', '9'], '1100': [], '1011': ['9'], '1101': [], '1110': [], '1111': []
    };
    for (const flags of Object.keys(expected)) {
        const options = {};
        ['mapped', 'unmapped', 'muted', 'orphaned'].forEach((flag, index) => { options[flag] = flags[index] === '1'; });
        assert.deepEqual(script.paginatePlayerWorkspaceRows(rows, options).rows.map(row => row.id), expected[flags], flags);
        const queryExpected = expected[flags].filter(id => rows.find(row => row.id === id).name.toLocaleLowerCase().includes('a'));
        assert.deepEqual(script.paginatePlayerWorkspaceRows(rows, Object.assign({ query: 'a' }, options)).rows.map(row => row.id), queryExpected, flags + ' query');
    }
});

test('Players workspace pagination supports empty and shrinking inputs', () => {
    assert.deepEqual(script.paginatePlayerWorkspaceRows([], { page: 4 }), {
        page: 1, pageCount: 1, total: 0, start: 0, end: 0, rows: []
    });
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), name: `P${i + 1}`, present: true, mapped: false, muted: false, orphaned: false, recipients: [] }));
    const result = script.paginatePlayerWorkspaceRows(rows.slice(0, 21), { page: 3 });
    assert.deepEqual({ page: result.page, pageCount: result.pageCount, start: result.start, end: result.end }, { page: 2, pageCount: 2, start: 21, end: 21 });
});

// task-3 panel clarity additions (delimited): explicit textual panel-state models.
// Every status below is text, never color-only; the panel renders these verbatim.

test('task-3: pagination status text mirrors the paged model exactly', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i + 1), name: `P${i + 1}`, present: true, mapped: false, muted: false, orphaned: false, recipients: [] }));
    assert.equal(script.formatPlayerPaginationStatus(script.paginatePlayerWorkspaceRows(rows, { page: 1 })), 'Showing 1–20 of 21 players · Page 1 of 2');
    assert.equal(script.formatPlayerPaginationStatus(script.paginatePlayerWorkspaceRows(rows, { page: 2 })), 'Showing 21–21 of 21 players · Page 2 of 2');
    assert.equal(script.formatPlayerPaginationStatus(script.paginatePlayerWorkspaceRows([], { page: 4 })), 'Showing 0 of 0 players · Page 1 of 1');
    assert.equal(script.formatPlayerPaginationStatus(null), 'Showing 0 of 0 players · Page 1 of 1');
});

test('task-3: filter state text names every active dimension', () => {
    assert.equal(script.describePlayerFilterState({}), 'No filters');
    assert.equal(script.describePlayerFilterState({ query: '  ' }), 'No filters');
    assert.equal(script.describePlayerFilterState({ query: 'ann' }), 'Filters: search "ann"');
    assert.equal(script.describePlayerFilterState({ mapped: true, muted: true }), 'Filters: mapped, muted');
    assert.equal(script.describePlayerFilterState({ query: 'x', mapped: true, unmapped: false, muted: false, orphaned: true }), 'Filters: search "x", mapped, orphaned');
    assert.equal(script.describePlayerFilterState(null), 'No filters');
});

test('task-3: trace count text pairs shown and total counts with filter words', () => {
    assert.equal(script.formatTraceCountStatus(0, 0, {}), 'Showing 0 of 0 traces · no filters');
    assert.equal(script.formatTraceCountStatus(12, 12, {}), 'Showing 12 of 12 traces · no filters');
    assert.equal(script.formatTraceCountStatus(5, 12, { scanId: 'scan-1', stage: '', outcome: '' }), 'Showing 5 of 12 traces · filtered by scan scan-1');
    assert.equal(script.formatTraceCountStatus(2, 9, { stage: 'dispatch', outcome: 'acknowledged' }), 'Showing 2 of 9 traces · filtered by stage dispatch, outcome acknowledged');
});

test('task-3: freshness text labels observed age against the 120s reload lifecycle', () => {
    assert.equal(script.describeFreshnessState(0, 1000000), 'Not recorded');
    assert.equal(script.describeFreshnessState(null, 1000000), 'Not recorded');
    assert.equal(script.describeFreshnessState(999000, 1000000), 'Fresh — observed 1s ago');
    assert.equal(script.describeFreshnessState(880000, 1000000), 'Fresh — observed 120s ago');
    assert.equal(script.describeFreshnessState(879000, 1000000), 'Stale — observed 121s ago');
    assert.equal(script.describeFreshnessState(1005000, 1000000), 'Fresh — observed 0s ago');
});

test('task-3: alert role error text is null only for valid snowflakes', () => {
    assert.equal(script.describeAlertRoleError('200000000000000001'), null);
    assert.equal(typeof script.describeAlertRoleError(''), 'string');
    assert.equal(typeof script.describeAlertRoleError('bad-role'), 'string');
    assert.equal(typeof script.describeAlertRoleError('123'), 'string');
    assert.equal(typeof script.describeAlertRoleError(null), 'string');
});

test('task-3: alert threshold errors mirror validateSettings ranges per field', () => {
    assert.equal(script.describeAlertThresholdError('', 'attack'), null);
    assert.equal(script.describeAlertThresholdError('5', 'attack'), null);
    assert.equal(script.describeAlertThresholdError('999', 'raid'), null);
    assert.equal(typeof script.describeAlertThresholdError('abc', 'attack'), 'string');
    assert.equal(typeof script.describeAlertThresholdError('0', 'attack'), 'string');
    assert.equal(typeof script.describeAlertThresholdError('1000', 'raid'), 'string');
    assert.equal(typeof script.describeAlertThresholdError('2.9', 'normal'), 'string');
    assert.equal(script.describeAlertThresholdError('3', 'normal'), null);
    assert.equal(typeof script.describeAlertThresholdError('0', 'high'), 'string');
    assert.equal(typeof script.describeAlertThresholdError('x', 'unknown-kind'), 'string');
});

test('verified panel persistence: typed write/readback outcomes', () => {
    let stored = JSON.stringify({ old: true });
    const healthy = { setItem: (key, value) => { stored = value; }, getItem: () => stored };
    assert.deepEqual(script.writeVerifiedJson(healthy, 'panel', { b: 2, a: 1 }), { ok: true, kind: 'written' });
    assert.deepEqual(script.writeVerifiedJson({ setItem() {}, getItem: () => JSON.stringify({ old: true }) }, 'panel', { next: true }), { ok: false, kind: 'readback-mismatch' });
    assert.equal(script.writeVerifiedJson({ setItem() { throw new Error('quota'); }, getItem() {} }, 'panel', { next: true }).kind, 'write-threw');
});

function settingsStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get length() { return values.size; },
        key(index) { return [...values.keys()][index] || null; },
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

const SETTINGS_HOST = 'world.example';
const SETTINGS_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fake-token';

test('settings backup rejects malformed present fields before any write', () => {
    const storage = settingsStorage({ unrelated: 'keep', travianAllianceSettings_v1: JSON.stringify({ [SETTINGS_HOST]: { attackThreshold: 4 } }) });
    const before = [...storage.values];
    const backup = { schemaVersion: 1, kind: 'taa-settings-backup', hostname: SETTINGS_HOST, data: {
        travianAllianceSettings_v1: { [SETTINGS_HOST]: { attackThreshold: 'bad' } },
        travianAllianceWebhookUrl_v1: { action: 'set', url: 'not-a-webhook' }
    } };
    const result = script.applySettingsBackup(backup, { hostname: SETTINGS_HOST, storage, webhook: { value: SETTINGS_WEBHOOK } });
    assert.equal(result.ok, false);
    assert.deepEqual([...storage.values], before);
});

test('settings backup treats absent fields as no-op and accepts legacy webhook string', () => {
    const storage = settingsStorage({ travianAllianceSettings_v1: JSON.stringify({ [SETTINGS_HOST]: { attackThreshold: 4 } }) });
    const webhook = { value: null };
    const backup = { schemaVersion: 1, kind: 'taa-settings-backup', hostname: SETTINGS_HOST, data: {
        travianAllianceWebhookUrl_v1: SETTINGS_WEBHOOK
    } };
    const result = script.applySettingsBackup(backup, { hostname: SETTINGS_HOST, storage, webhook });
    assert.equal(result.ok, true);
    assert.equal(webhook.value, SETTINGS_WEBHOOK);
    assert.deepEqual(JSON.parse(storage.getItem('travianAllianceSettings_v1')), { [SETTINGS_HOST]: { attackThreshold: 4 } });
});

test('settings backup supports explicit webhook clear and rolls back exact absent keys on failure', () => {
    const storage = settingsStorage({ unrelated: 'keep' });
    const webhook = { value: SETTINGS_WEBHOOK };
    const backup = { schemaVersion: 1, kind: 'taa-settings-backup', hostname: SETTINGS_HOST, data: {
        travianAllianceWebhookUrl_v1: { action: 'clear' },
        travianAllianceSettings_v1: { [SETTINGS_HOST]: { attackThreshold: 7 } }
    } };
    const result = script.applySettingsBackup(backup, { hostname: SETTINGS_HOST, storage, webhook, setWebhook() { throw new Error('quota'); } });
    assert.equal(result.ok, false);
    assert.deepEqual([...storage.values], [['unrelated', 'keep']]);
    assert.equal(webhook.value, SETTINGS_WEBHOOK);
});

test('settings backup export uses command-shaped webhook and rejects malformed envelopes', () => {
    const storage = settingsStorage({ unrelated: 'keep' });
    const backup = script.buildSettingsBackup({ hostname: SETTINGS_HOST, storage, webhook: SETTINGS_WEBHOOK, nowMs: 0 });
    assert.deepEqual(backup.data.travianAllianceWebhookUrl_v1, { action: 'set', url: SETTINGS_WEBHOOK });
    for (const raw of [{ kind: 'wrong', schemaVersion: 1, data: {} }, { kind: 'taa-settings-backup', schemaVersion: 2, data: {} }, { kind: 'taa-settings-backup', schemaVersion: 1, data: [] }]) {
        const before = [...storage.values];
        const result = script.applySettingsBackup(raw, { hostname: SETTINGS_HOST, storage, webhook: { value: null } });
        assert.equal(result.ok, false);
        assert.deepEqual([...storage.values], before);
    }
});

test('settings backup readback failure restores existing and absent keys exactly', () => {
    const storage = settingsStorage({ keep: 'raw', travianAllianceSettings_v1: JSON.stringify({ [SETTINGS_HOST]: { attackThreshold: 3 } }) });
    const before = [...storage.values];
    const originalSet = storage.setItem.bind(storage);
    let writes = 0;
    storage.setItem = (key, value) => { writes += 1; originalSet(key, value); if (writes === 2) storage.getItem = () => JSON.stringify({ mismatch: true }); };
    const result = script.applySettingsBackup({ schemaVersion: 1, kind: 'taa-settings-backup', data: { travianAllianceSettings_v1: { [SETTINGS_HOST]: { attackThreshold: 8 } }, travianAllianceWebhookUrl_v1: { action: 'clear' } } }, { hostname: SETTINGS_HOST, storage, webhook: { value: SETTINGS_WEBHOOK } });
    assert.equal(result.ok, false);
    assert.deepEqual([...storage.values], before);
});

test('settings backup GM get/set failures are rejected without local writes', () => {
    const storage = settingsStorage({ keep: 'raw' });
    const before = [...storage.values];
    const backup = { schemaVersion: 1, kind: 'taa-settings-backup', data: { travianAllianceWebhookUrl_v1: { action: 'set', url: SETTINGS_WEBHOOK } } };
    assert.equal(script.applySettingsBackup(backup, { hostname: SETTINGS_HOST, storage, gm: { get() { throw new Error('read'); } } }).ok, false);
    assert.equal(script.applySettingsBackup(backup, { hostname: SETTINGS_HOST, storage, gm: { get: () => undefined, set() { throw new Error('write'); } } }).ok, false);
    assert.deepEqual([...storage.values], before);
});

test('loadery bez localStorage: bezpieczne wartości domyślne', () => {
    assert.deepEqual(script.loadMappings(), {});
    assert.deepEqual(script.loadMutedPlayers(), {});
    assert.deepEqual(script.loadHistory(), {});
    assert.deepEqual(script.loadPendingBatch(), {});
    assert.deepEqual(script.loadDiagnostics(), {});
    assert.deepEqual(script.loadFailedBatch(), {});
    assert.deepEqual(script.loadSettings(HOST), script.getDefaultSettings());
    assert.deepEqual(script.loadDiscordConfig(), { roleId: null, leaveRoleId: null });
});

test('savery bez localStorage: no-op bez rzucania', () => {
    assert.equal(script.saveMappings({ a: 1 }), undefined);
    assert.equal(script.saveMutedPlayers({ a: 1 }), undefined);
    assert.equal(script.saveHistory({}, HOST), undefined);
    assert.equal(script.savePendingBatch({}, HOST), false);
    assert.equal(script.saveDiagnostics({}, HOST), undefined);
    assert.equal(script.saveSettings({}, HOST), undefined);
    assert.equal(script.saveDiscordConfig({ roleId: null, leaveRoleId: null }), undefined);
    assert.equal(script.saveFailedBatch({}, HOST), false);
});

// ---------------------------------------------------------------------------
// Failed queue (trwałe porażki / wyczerpane retry)
// ---------------------------------------------------------------------------

/*
 * Tymczasowy mock localStorage (sekwencyjnie, z przywróceniem stanu).
 * Testy w tym pliku poza tą sekcją działają bez localStorage — Node
 * domyślnie nie ma tej globalnej zmiennej.
 */
function withLocalStorage(seed, fn) {
    const map = Object.assign({}, seed || {});
    const previous = global.localStorage;

    global.localStorage = {
        getItem: key =>
            Object.prototype.hasOwnProperty.call(map, key)
                ? map[key]
                : null,
        setItem: (key, value) => {
            map[key] = String(value);
        },
        removeItem: key => {
            delete map[key];
        }
    };

    try {
        return fn(map);
    } finally {
        if (previous === undefined) {
            delete global.localStorage;
        } else {
            global.localStorage = previous;
        }
    }
}

const FAILED_KEY = script.FAILED_BATCH_STORAGE_KEY;
const PENDING_KEY = script.PENDING_BATCH_STORAGE_KEY;

function makeFailedEvent(name) {
    return {
        name,
        url: 'https://cw.x2.international.travian.com/profile/385',
        attackCount: 2,
        raidCount: 1,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 2,
        addedRaidCount: 1,
        eventType: 'mixed',
        description: name + ' description'
    };
}

test('failed queue: nowe eksporty i stałe', () => {
    for (const name of [
        'FAILED_BATCH_STORAGE_KEY',
        'FAILED_QUEUE_MAX_EVENTS',
        'loadFailedBatch',
        'saveFailedBatch',
        'enqueueFailedEvents',
        'getFailedEvents',
        'countFailedEvents',
        'clearFailedEvents',
        'requeueFailedEvents'
    ]) {
        assert.ok(name in script, 'brak eksportu ' + name);
    }

    assert.equal(script.FAILED_QUEUE_MAX_EVENTS, 50);
    assert.equal(
        script.FAILED_BATCH_STORAGE_KEY,
        'travianAllianceFailedBatch_v1'
    );
    assert.notEqual(
        script.FAILED_BATCH_STORAGE_KEY,
        PENDING_KEY,
        'failed queue jest rozłączna od pending'
    );
});

test('enqueueFailedEvents: FIFO, cap 50, lastFailure, płaski snapshot', () => {
    const events = [];
    for (let i = 1; i <= 60; i += 1) {
        events.push(makeFailedEvent('Player ' + i));
    }

    let failed = script.enqueueFailedEvents(
        {},
        HOST,
        events,
        1700000000000,
        '500'
    );

    const entry = failed[HOST];
    assert.equal(entry.events.length, script.FAILED_QUEUE_MAX_EVENTS);
    assert.equal(entry.events[0].name, 'Player 11', 'najstarsze odcięte');
    assert.equal(
        entry.events[entry.events.length - 1].name,
        'Player 60',
        'FIFO zachowane'
    );
    assert.deepEqual(entry.lastFailure, {
        atMs: 1700000000000,
        statusOrError: '500'
    });
    assert.deepEqual(entry.events[0], {
        name: 'Player 11',
        url: 'https://cw.x2.international.travian.com/profile/385',
        attackCount: 2,
        raidCount: 1,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 2,
        addedRaidCount: 1,
        eventType: 'mixed'
    }, 'toPendingEvent: płaski snapshot bez description');

    // drugie dopisanie: append z capem, ostatnia porażka nadpisana
    failed = script.enqueueFailedEvents(
        failed,
        HOST,
        [makeFailedEvent('Player 61')],
        1700000000001,
        'network'
    );
    assert.equal(failed[HOST].events.length, 50);
    assert.equal(failed[HOST].events[0].name, 'Player 12');
    assert.equal(failed[HOST].events[49].name, 'Player 61');
    assert.equal(
        failed[HOST].lastFailure.statusOrError,
        'network',
        'tylko OSTATNIA porażka na świat'
    );

    // nie-tablica / pusta tablica -> ta sama referencja (bez mutacji)
    const original = {
        [HOST]: { events: [makeFailedEvent('Keep')] }
    };
    assert.equal(
        script.enqueueFailedEvents(original, HOST, 'nope', 1, 'x'),
        original
    );
    assert.equal(
        script.enqueueFailedEvents(original, HOST, [], 1, 'x'),
        original
    );
});

test('getFailedEvents / countFailedEvents / clearFailedEvents', () => {
    const failed = {
        [HOST]: {
            events: [makeFailedEvent('A'), makeFailedEvent('B')],
            lastFailure: { atMs: 5, statusOrError: '403' }
        },
        'other.world': { events: [makeFailedEvent('X')] }
    };

    const snapshot = script.getFailedEvents(failed, HOST);
    assert.equal(snapshot.events.length, 2);
    assert.deepEqual(snapshot.lastFailure, {
        atMs: 5,
        statusOrError: '403'
    });
    assert.notEqual(
        snapshot.events,
        failed[HOST].events,
        'kopia tablicy (elementy płytko — konwencja snapshotBatch)'
    );
    assert.equal(script.getFailedEvents(failed, 'unknown.world'), null);
    assert.equal(
        script.getFailedEvents({ [HOST]: { events: [] } }, HOST),
        null,
        'pusta kolejka -> null'
    );
    assert.equal(
        script.getFailedEvents({ [HOST]: [1, 2] }, HOST),
        null,
        'uszkodzony kształt -> null'
    );

    assert.equal(script.countFailedEvents(failed, HOST), 2);
    assert.equal(script.countFailedEvents(failed, 'unknown.world'), 0);
    assert.equal(script.countFailedEvents({ [HOST]: 'nope' }, HOST), 0);
    assert.equal(script.countFailedEvents(null, HOST), 0);

    const cleared = script.clearFailedEvents(failed, HOST);
    assert.ok(!(HOST in cleared), 'wpis świata usunięty');
    assert.ok('other.world' in cleared, 'pozostałe światy nietknięte');
    assert.ok(HOST in failed, 'wejście niezmutowane');
    assert.equal(
        script.clearFailedEvents(failed, 'unknown.world'),
        failed,
        'nieznany host -> ta sama referencja'
    );
});

test('loadFailedBatch: uszkodzony/brakujący storage -> {}', () => {
    withLocalStorage({}, map => {
        assert.deepEqual(script.loadFailedBatch(), {});

        map[FAILED_KEY] = 'not-json{';
        assert.deepEqual(script.loadFailedBatch(), {});

        map[FAILED_KEY] = 'null';
        assert.deepEqual(script.loadFailedBatch(), {});

        map[FAILED_KEY] = '[1,2]';
        assert.deepEqual(script.loadFailedBatch(), {});

        map[FAILED_KEY] = JSON.stringify({
            [HOST]: { events: [1], lastFailure: { atMs: 1, statusOrError: 'x' } }
        });
        assert.deepEqual(script.loadFailedBatch(), {
            [HOST]: { events: [1], lastFailure: { atMs: 1, statusOrError: 'x' } }
        });
    });
});

test('saveFailedBatch: status sukcesu, odzyskiwalny uszkodzony magazyn', () => {
    // bez localStorage -> false (no-op)
    assert.equal(script.saveFailedBatch({}, HOST), false);

    withLocalStorage({}, map => {
        assert.equal(
            script.saveFailedBatch({ [HOST]: { events: [1] } }, HOST),
            true
        );
        assert.deepEqual(JSON.parse(map[FAILED_KEY]), {
            [HOST]: { events: [1] }
        });

        // uszkodzony magazyn: replace nadpisuje go DOKŁADNIE paczką
        map[FAILED_KEY] = 'garbage{';
        assert.equal(
            script.saveFailedBatch(
                {
                    [HOST]: { events: [2] },
                    'other.world': { events: [9] }
                },
                HOST
            ),
            true
        );
        assert.deepEqual(JSON.parse(map[FAILED_KEY]), {
            [HOST]: { events: [2] },
            'other.world': { events: [9] }
        });

        // replace: zapis opróżnionej paczki trwale usuwa wpis świata,
        // a pozostałe światy zostają
        const stored = JSON.parse(map[FAILED_KEY]);
        const cleared = script.clearFailedEvents(stored, HOST);
        assert.equal(script.saveFailedBatch(cleared, HOST), true);
        assert.deepEqual(JSON.parse(map[FAILED_KEY]), {
            'other.world': { events: [9] }
        });

        // rzucający setItem -> false, bez rzucania na zewnątrz
        global.localStorage = {
            getItem: () => null,
            setItem: () => {
                throw new Error('quota');
            }
        };
        assert.equal(
            script.saveFailedBatch({ [HOST]: { events: [1] } }, HOST),
            false
        );
    });
});

test('requeueFailedEvents: pending zapisany PRZED czyszczeniem failed', () => {
    withLocalStorage({}, map => {
        const failedEvents = [makeFailedEvent('Failed A'), makeFailedEvent('Failed B')];

        const saved = script.saveFailedBatch(
            script.enqueueFailedEvents(
                {},
                HOST,
                failedEvents,
                1700000000000,
                '404'
            ),
            HOST
        );
        assert.equal(saved, true);

        const result = script.requeueFailedEvents(HOST);
        assert.deepEqual(result, {
            requeued: 2,
            failedCount: 2,
            saved: true
        });

        // pending zawiera odzyskane eventy w kolejności FIFO
        const pending = script.snapshotBatch(
            script.loadPendingBatch(),
            HOST
        );
        assert.equal(pending.events.length, 2);
        assert.deepEqual(
            pending.events.map(event => event.name),
            ['Failed A', 'Failed B']
        );

        // failed queue wyczyszczona dopiero po zapisie pending
        assert.equal(
            script.getFailedEvents(script.loadFailedBatch(), HOST),
            null
        );
        assert.equal(
            script.countFailedEvents(script.loadFailedBatch(), HOST),
            0
        );
    });
});

test('requeueFailedEvents: nieudany zapis pending zachowuje failed queue', () => {
    withLocalStorage({}, map => {
        script.saveFailedBatch(
            script.enqueueFailedEvents(
                {},
                HOST,
                [makeFailedEvent('Keep me')],
                1700000000000,
                '500'
            ),
            HOST
        );

        // psujemy wyłącznie zapis PENDING (setItem rzuca dla tego klucza)
        const originalSetItem = global.localStorage.setItem;
        global.localStorage.setItem = (key, value) => {
            if (key === PENDING_KEY) {
                throw new Error('quota');
            }
            originalSetItem(key, value);
        };

        const result = script.requeueFailedEvents(HOST);
        assert.equal(result.saved, false);
        assert.equal(result.requeued, 0);
        assert.equal(result.failedCount, 1);

        // failed queue NIETKNIĘTA — duplikat lepszy niż utrata
        assert.equal(
            script.countFailedEvents(script.loadFailedBatch(), HOST),
            1
        );
        assert.deepEqual(
            script.getFailedEvents(script.loadFailedBatch(), HOST)
                .events.map(event => event.name),
            ['Keep me']
        );

        // pending pusty (zapis się nie powiódł)
        assert.equal(
            script.snapshotBatch(script.loadPendingBatch(), HOST),
            null
        );

        // po przywróceniu magazynu ponowienie działa
        global.localStorage.setItem = originalSetItem;

        const retry = script.requeueFailedEvents(HOST);
        assert.equal(retry.saved, true);
        assert.equal(retry.requeued, 1);
        assert.equal(
            script.countFailedEvents(script.loadFailedBatch(), HOST),
            0
        );
    });
});

test('requeueFailedEvents: pusta failed queue -> 0/0/false bez zmian', () => {
    withLocalStorage({}, () => {
        const result = script.requeueFailedEvents(HOST);
        assert.deepEqual(result, {
            requeued: 0,
            failedCount: 0,
            saved: false
        });
        assert.equal(
            script.snapshotBatch(script.loadPendingBatch(), HOST),
            null,
            'pending nietknięty'
        );
    });
});

test('requeueFailedEvents: pełna kolejka pending + błąd setItem -> failed zachowana', () => {
    withLocalStorage({}, map => {
        // pending w 100% pełny (QUEUE_MAX_EVENTS) — sama długość
        // nie odróżni udanego zapisu od nieudanego (zawsze 50)
        const pendingEvents = [];
        for (let i = 0; i < script.QUEUE_MAX_EVENTS; i += 1) {
            pendingEvents.push(makeFailedEvent('Pending ' + i));
        }
        script.savePendingBatch(
            script.enqueueEvents({}, HOST, pendingEvents),
            HOST
        );

        // failed queue z jednym eventem do ponowienia
        script.saveFailedBatch(
            script.enqueueFailedEvents(
                {},
                HOST,
                [makeFailedEvent('Lost?')],
                1700000000000,
                '500'
            ),
            HOST
        );

        // setItem rzuca wyłącznie dla PENDING — zapis NIE następuje,
        // a read-back długości dalej pokazywałby 50 (pełna kolejka)
        const originalSetItem = global.localStorage.setItem;
        global.localStorage.setItem = (key, value) => {
            if (key === PENDING_KEY) {
                throw new Error('quota');
            }
            originalSetItem(key, value);
        };

        const result = script.requeueFailedEvents(HOST);
        assert.equal(result.saved, false, 'brak pełnego sukcesu');
        assert.equal(result.requeued, 0, 'nic nie dopisane do pending');
        assert.equal(result.failedCount, 1);

        // failed queue NIETKNIĘTA mimo pełnego pending — dowód na to,
        // że jawny status savePendingBatch jest sprawdzany PRZED read-backiem
        assert.equal(
            script.countFailedEvents(script.loadFailedBatch(), HOST),
            1
        );
        assert.deepEqual(
            script.getFailedEvents(script.loadFailedBatch(), HOST)
                .events.map(event => event.name),
            ['Lost?']
        );

        // pending pozostał nietknięty (nadal 50 starych eventów)
        const pendingAfter = script.snapshotBatch(
            script.loadPendingBatch(),
            HOST
        );
        assert.equal(pendingAfter.events.length, script.QUEUE_MAX_EVENTS);
        assert.ok(
            !pendingAfter.events.some(event => event.name === 'Lost?'),
            'failed event nie trafił do pending'
        );

        // sanity: po przywróceniu magazynu ponowienie działa (cap odcina
        // najstarsze pending, failed event ląduje na końcu kolejki)
        global.localStorage.setItem = originalSetItem;

        const retry = script.requeueFailedEvents(HOST);
        assert.equal(retry.saved, true);
        assert.equal(retry.requeued, 1);
        assert.equal(
            script.countFailedEvents(script.loadFailedBatch(), HOST),
            0
        );
        const pendingRetry = script.snapshotBatch(
            script.loadPendingBatch(),
            HOST
        );
        assert.equal(
            pendingRetry.events[pendingRetry.events.length - 1].name,
            'Lost?'
        );
    });
});

test('requeueFailedEvents: nieudany clear failed -> requeued>0, saved=false', () => {
    withLocalStorage({}, map => {
        script.saveFailedBatch(
            script.enqueueFailedEvents(
                {},
                HOST,
                [makeFailedEvent('Duplicated?')],
                1700000000000,
                '500'
            ),
            HOST
        );

        // psujemy wyłącznie zapis FAILED — pending zapisze się poprawnie
        const originalSetItem = global.localStorage.setItem;
        global.localStorage.setItem = (key, value) => {
            if (key === FAILED_KEY) {
                throw new Error('quota');
            }
            originalSetItem(key, value);
        };

        const result = script.requeueFailedEvents(HOST);
        assert.equal(result.saved, false, 'pełny sukces bez potwierdzenia clear');
        assert.equal(result.requeued, 1, 'event trafił do pending');
        assert.equal(result.failedCount, 1);

        // event jest w pending ORAZ w failed — zamierzony duplikat,
        // brak utraty
        const pending = script.snapshotBatch(
            script.loadPendingBatch(),
            HOST
        );
        assert.equal(pending.events[0].name, 'Duplicated?');
        assert.equal(
            script.countFailedEvents(script.loadFailedBatch(), HOST),
            1
        );
    });
});

// ---------------------------------------------------------------------------
// Limity payloadu Discorda (budżet-aware chunking, mentions, embed)
// ---------------------------------------------------------------------------

const ORIGIN = 'https://cw.x2.international.travian.com';
const FALLBACK_HREF = 'https://cw.x2.international.travian.com/alliance/members';

function discordEvent(name, counts, timing = {}) {
    const digits = name.replace(/\D/g, '');

    return {
        name,
        url: '/profile/' + (digits || '1'),
        attackCount: counts.attack,
        raidCount: counts.raid,
        addedAttackCount: counts.addedAttack,
        addedRaidCount: counts.addedRaid,
        eventType: counts.addedAttack > 0 && counts.addedRaid > 0
            ? 'mixed'
            : counts.addedRaid > 0
                ? 'raid'
                : 'attack',
        observedAtMs: timing.observedAtMs,
        dispatchedAtMs: timing.dispatchedAtMs
    };
}

function buildPayloads(events, overrides = {}) {
    return script.buildDiscordPayloads(events, Object.assign({
        allianceUrl: FALLBACK_HREF,
        context: { origin: ORIGIN, fallbackHref: FALLBACK_HREF },
        worldHostname: HOST,
        settings: script.validateSettings({
            attackThreshold: 1,
            raidThreshold: 1,
            normalMax: 2,
            highMax: 5
        }),
        approximateObserved: false,
        observedAtMs: Date.UTC(2026, 7, 23, 23, 3, 12),
        dispatchedAtMs: Date.UTC(2026, 7, 23, 23, 3, 14),
        roleId: null,
        userIds: []
    }, overrides));
}

test('queue event preserves approximate observation metadata and absent observation time', () => {
    const approximate = script.toPendingEvent({
        name: 'Approximate',
        url: '/profile/700',
        attackCount: 1,
        raidCount: 0,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack',
        approximateObserved: true,
        observedAtApproximate: true
    });
    assert.equal(approximate.approximateObserved, true);
    assert.equal(approximate.observedAtApproximate, true);
    assert.equal(Object.prototype.hasOwnProperty.call(approximate, 'observedAtMs'), false);

    const unavailable = script.toPendingEvent({
        name: 'Unavailable',
        url: '/profile/701',
        attackCount: 0,
        raidCount: 1,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 0,
        addedRaidCount: 1,
        eventType: 'raid'
    });
    assert.equal(Object.prototype.hasOwnProperty.call(unavailable, 'observedAtMs'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(unavailable, 'approximateObserved'), false);
});

const RAID_TWO = {
    events: [
        { testId: 'raid-lenny', name: 'Lenny Barre', url: '/profile/101', attackCount: 0, raidCount: 1, addedAttackCount: 0, addedRaidCount: 1, eventType: 'raid', priority: 'normal' },
        { testId: 'raid-quinnos', name: 'Quinnos', url: '/profile/102', attackCount: 0, raidCount: 1, addedAttackCount: 0, addedRaidCount: 1, eventType: 'raid', priority: 'normal' }
    ],
    options: {
        allianceUrl: 'https://cw.x2.international.travian.com/alliance/members',
        context: { origin: 'https://cw.x2.international.travian.com', fallbackHref: 'https://cw.x2.international.travian.com/alliance/members' },
        worldHostname: HOST,
        settings: script.validateSettings({
            attackThreshold: 1,
            raidThreshold: 1,
            normalMax: 2,
            highMax: 5
        }),
        approximateObserved: false,
        observedAtMs: Date.UTC(2026, 7, 23, 9, 46, 1, 0),
        dispatchedAtMs: Date.UTC(2026, 7, 23, 9, 46, 1, 0),
        roleId: null,
        userIds: []
    }
};

test('README compact alert bytes and documented contracts', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    const startMarker = '<!-- discord-alert-example:start -->';
    const endMarker = '<!-- discord-alert-example:end -->';
    assert.equal(readme.split(startMarker).length - 1, 1);
    assert.equal(readme.split(endMarker).length - 1, 1);

    const start = readme.indexOf(startMarker) + startMarker.length;
    const end = readme.indexOf(endMarker);
    assert.equal(readme[start], '\n');
    assert.equal(readme[end - 1], '\n');
    const markerBytes = readme.slice(start + 1, end - 1);
    assert.equal(
        markerBytes,
        canonicalDiscord.serializePayloadsForDocumentation(canonicalDiscord.payloadsForCase('raid-two'))
    );

    assert.match(readme, /2000/);
    assert.match(readme, /4096/);
    assert.match(readme, /1024/);
    assert.match(readme, /6000/);
    assert.match(readme, /10/);
    assert.match(readme, /part X\/Y/);
    assert.match(readme, /first embed has exactly `New`, `Active now`, and `Priority`/i);
    assert.match(readme, /continuations use empty mention allowlists/i);
    assert.match(readme, /allowed_mentions/);
    assert.match(readme, /safe links/i);
    assert.match(readme, /🚨.*🛡️.*🔄/s);
    assert.match(readme, /New.*Active now.*Priority/s);
    assert.match(readme, /5\.2\.6/);
    assert.match(readme, /approximate observation/i);
    assert.match(readme, /Observation time unavailable/);
    assert.match(readme, /Now: .*attacks? \/ .*raids?/i);
    assert.match(readme, /last embed of every request/i);
    assert.match(readme, /one logical dispatch timestamp/i);
    assert.match(readme, /not retried automatically/i);
    assert.match(readme, /without partial|unchanged/i);
    assert.match(readme, /at-least-once/);
    assert.match(readme, /wait=true/);
    assert.match(readme, /Timestamp/);
});

test('README rejects stale grammar and secrets', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    const startMarker = '<!-- discord-alert-example:start -->';
    const endMarker = '<!-- discord-alert-example:end -->';
    const start = readme.indexOf(startMarker) + startMarker.length + 1;
    const end = readme.indexOf(endMarker) - 1;
    const markerBytes = readme.slice(start, end);

    assert.doesNotMatch(markerBytes, /Open alliance profile/);
    assert.doesNotMatch(markerBytes, /queue \d+ s/);
    assert.doesNotMatch(readme, /discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+/);
});

test('README departure operator guidance and allowed_mentions contract matches live builder', () => {
    const readme = fs.readFileSync('README.md', 'utf8');

    assert.match(readme, /Attack role.*roleId/s);
    assert.match(readme, /Leave-moderator role.*leaveRoleId/s);
    assert.match(readme, /travianAllianceDiscordConfig_v1/);
    assert.match(readme, /validateDiscordRoleId/);
    assert.match(readme, /taa-leave-role-input/);
    assert.match(readme, /taa-leave-role-set/);
    assert.match(readme, /taa-leave-role-clear/);
    assert.match(readme, /taa-leave-role-current/);
    assert.match(readme, /mappings\[hostname\]\[playerId\]/);
    assert.match(readme, /pre-existing.*mapping/i);
    assert.match(readme, /separate.*global.*role/i);
    assert.match(readme, /never removes Discord access automatically|manually revoke/i);
    assert.match(readme, /Mentionable/i);
    assert.match(readme, /at-least-once/i);

    assert.match(readme, /allowed_mentions/);
    assert.match(readme, /no.*parse/i);
    assert.doesNotMatch(readme, /\{parse:\s*\[\]/);
    assert.match(readme, /\{ users:/);
    assert.match(readme, /roles:\s*\[/);
    assert.match(readme, /first request.*content/i);
    assert.match(readme, /continuations use empty.*content/i);
    assert.match(readme, /Embed.*never contain mention/i);

    const canonicalPayloads = canonicalDiscord.payloadsForCase('roster');
    assert.ok(Array.isArray(canonicalPayloads) && canonicalPayloads.length === 1);
    const canonicalPayload = canonicalPayloads[0];
    assert.equal(typeof canonicalPayload.content, 'string');
    assert.equal(canonicalPayload.content, '');
    assert.deepEqual(canonicalPayload.allowed_mentions, { users: [] });
    assert.ok(!('roles' in canonicalPayload.allowed_mentions));
    assert.ok(!('parse' in canonicalPayload.allowed_mentions));

    const liveRoster = canonicalDiscord.previewCases.roster().events;
    const liveOptions = canonicalDiscord.previewCases.roster().options;
    const livePayloads = script.buildDiscordPayloads(liveRoster, liveOptions);
    assert.deepEqual(livePayloads[0].content, canonicalPayload.content);
    assert.deepEqual(livePayloads[0].allowed_mentions, canonicalPayload.allowed_mentions);

    const withLeaveRole = Object.assign({}, liveOptions, { leaveRoleId: ROLE, userIds: [UID_A] });
    const leaveMapped = script.buildDiscordPayloads([
        { name: 'Beta', url: '/profile/202', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'leave', playerId: '202' }
    ], withLeaveRole);
    assert.equal(leaveMapped[0].content, `<@&${ROLE}> <@${UID_A}>`);
    assert.deepEqual(leaveMapped[0].allowed_mentions, { users: [UID_A], roles: [ROLE] });
    assert.equal(JSON.stringify(leaveMapped[0].embeds).includes('<@'), false);
    assert.equal('parse' in leaveMapped[0].allowed_mentions, false);

    const { spawnSync } = require('node:child_process');
    const auditEnv = Object.assign({}, process.env);
    delete auditEnv.NODE_TEST_CONTEXT;
    const auditResult = spawnSync(process.execPath, ['test/fixtures/discord/static-format-audit.cjs', '--file', 'script.txt', '--readme', 'README.md'], { encoding: 'utf8', env: auditEnv });
    assert.equal(auditResult.status, 0, auditResult.stdout + auditResult.stderr);
    const parsed = JSON.parse(auditResult.stdout);
    assert.equal(parsed.verdict, 'PASS');
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.readme.pass, true);
});

test('compact presentation snapshots', () => {
    const raid = script.buildCompactDiscordPresentation(
        RAID_TWO.events,
        RAID_TWO.options
    );

    assert.deepEqual(raid, {
        baseTitle: '🛡️ Alliance raid · 2 players',
        eventClass: 'raid',
        allianceUrl: FALLBACK_HREF,
        color: 15158332,
        summaryFields: [
            { name: 'New', value: '**+2 raids**', inline: true },
            { name: 'Active now', value: '0 attacks / 2 raids', inline: true },
            { name: 'Priority', value: 'Normal', inline: true }
        ],
        lineEntries: [
            {
                event: RAID_TWO.events[0],
                sourceIndex: 0,
                line: '[Lenny Barre](https://cw.x2.international.travian.com/profile/101) — **+1 raid**\nNow: 0 attacks / 1 raid'
            },
            {
                event: RAID_TWO.events[1],
                sourceIndex: 1,
                line: '[Quinnos](https://cw.x2.international.travian.com/profile/102) — **+1 raid**\nNow: 0 attacks / 1 raid'
            }
        ],
        footer: { text: `${HOST} · Observed <1s before dispatch` },
        timestamp: '2026-08-23T09:46:01.000Z'
    });
    assert.deepEqual(
        raid.lineEntries.map(entry => entry.event.testId),
        ['raid-lenny', 'raid-quinnos']
    );
    assert.equal(Object.prototype.hasOwnProperty.call(raid, 'testId'), false);
    for (const entry of raid.lineEntries) {
        assert.deepEqual(Object.keys(entry), ['event', 'sourceIndex', 'line']);
        assert.equal(Object.prototype.hasOwnProperty.call(entry, 'testId'), false);
    }

    const attack = script.buildCompactDiscordPresentation([
        { testId: 'attack', name: 'Solo', url: '/profile/1', attackCount: 17, raidCount: 0, addedAttackCount: 2, addedRaidCount: 0, eventType: 'attack', priority: 'high' }
    ], RAID_TWO.options);
    assert.equal(attack.baseTitle, '🚨 Alliance attack · 1 player');
    assert.equal(attack.color, 15158332);
    assert.deepEqual(attack.summaryFields, [
        { name: 'New', value: '**+2 attacks**', inline: true },
        { name: 'Active now', value: '17 attacks / 0 raids', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
    assert.equal(attack.lineEntries[0].line, '[Solo](https://cw.x2.international.travian.com/profile/1) — **+2 attacks**\nNow: 17 attacks / 0 raids');

    const mixed = script.buildCompactDiscordPresentation([
        { testId: 'mixed', name: 'Mixed', url: '/profile/2', attackCount: 8, raidCount: 1, addedAttackCount: 1, addedRaidCount: 1, eventType: 'mixed', priority: 'critical' }
    ], RAID_TWO.options);
    assert.equal(mixed.baseTitle, '🚨 Alliance attack · 1 player');
    assert.equal(mixed.lineEntries[0].line, '[Mixed](https://cw.x2.international.travian.com/profile/2) — **+1 attack** · **+1 raid**\nNow: 8 attacks / 1 raid');
    assert.deepEqual(mixed.summaryFields, [
        { name: 'New', value: '**+1 attack** · **+1 raid**', inline: true },
        { name: 'Active now', value: '8 attacks / 1 raid', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);

    const attackAndRoster = script.buildCompactDiscordPresentation([
        { testId: 'join', name: 'Joiner', url: '/profile/3', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'join', priority: 'normal' },
        { testId: 'attack', name: 'Attacker', url: '/profile/4', attackCount: 1, raidCount: 0, addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack', priority: 'normal' }
    ], RAID_TWO.options);
    assert.equal(attackAndRoster.eventClass, 'attack');
    assert.deepEqual(attackAndRoster.lineEntries.map(entry => entry.event.testId), ['attack', 'join']);
    assert.equal(attackAndRoster.lineEntries[1].line, '[Joiner](https://cw.x2.international.travian.com/profile/3) — joined the alliance');
    assert.deepEqual(attackAndRoster.summaryFields, [
        { name: 'New', value: '**+1 attack**', inline: true },
        { name: 'Active now', value: '1 attack / 0 raids', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);

    const joinOnly = script.buildCompactDiscordPresentation([
        { testId: 'join-only', name: 'Newcomer', url: '/profile/10', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'join', priority: 'normal' }
    ], RAID_TWO.options);
    assert.equal(joinOnly.baseTitle, '🔄 Alliance changes · 1 player');
    assert.deepEqual(joinOnly.summaryFields, [
        { name: 'New', value: '**1 joined**', inline: true },
        { name: 'Active now', value: '—', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
    assert.equal(joinOnly.lineEntries[0].line, '[Newcomer](https://cw.x2.international.travian.com/profile/10) — joined the alliance');

    const roster = script.buildCompactDiscordPresentation([
        { testId: 'join', name: 'Alpha', url: '/profile/5', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'join', priority: 'normal' },
        { testId: 'leave', name: 'Beta', url: '/profile/6', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'leave', priority: 'normal' }
    ], RAID_TWO.options);
    assert.equal(roster.baseTitle, '🔄 Alliance changes · 2 players');
    assert.deepEqual(roster.summaryFields, [
        { name: 'New', value: '**1 joined** · **1 left**', inline: true },
        { name: 'Active now', value: '—', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
    assert.deepEqual(roster.lineEntries.map(entry => entry.line), [
        '[Alpha](https://cw.x2.international.travian.com/profile/5) — joined the alliance',
        '[Beta](https://cw.x2.international.travian.com/profile/6) — left the alliance'
    ]);

    const zero = script.buildCompactDiscordPresentation([
        { testId: 'zero', name: 'Quiet', url: '/profile/7', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'attack', priority: 'normal' }
    ], RAID_TWO.options);
    assert.equal(zero.baseTitle, '🚨 Alliance attack · 1 player');
    assert.equal(zero.summaryFields[0].value, 'No new activity');
    assert.equal(zero.lineEntries[0].line, '[Quiet](https://cw.x2.international.travian.com/profile/7) — no new activity\nNow: 0 attacks / 0 raids');
    assert.equal(script.buildCompactDiscordPresentation([], RAID_TWO.options), null);

    const dispatchOnly = script.buildCompactDiscordTiming(NaN, RAID_TWO.options.dispatchedAtMs);
    assert.deepEqual(dispatchOnly, {
        footer: { text: 'Observation time unavailable' },
        timestamp: '2026-08-23T09:46:01.000Z'
    });
    assert.deepEqual(
        script.buildCompactDiscordTiming(RAID_TWO.options.observedAtMs, NaN),
        { footer: { text: 'Observation time unavailable' } }
    );
    assert.deepEqual(
        script.buildCompactDiscordTiming(NaN, NaN),
        { footer: { text: 'Observation time unavailable' } }
    );
    assert.deepEqual(
        script.buildCompactDiscordTiming(RAID_TWO.options.dispatchedAtMs + 1, RAID_TWO.options.dispatchedAtMs),
        {
            footer: { text: 'Observation time unavailable' },
            timestamp: '2026-08-23T09:46:01.000Z'
        }
    );
});

test('compact presentation rejects unsafe names urls and times', () => {
    const context = { origin: ORIGIN, fallbackHref: FALLBACK_HREF };
    const unsafe = script.buildCompactDiscordPlayerLine({
        name: '@everyone [x](evil)',
        url: 'https://evil.example.com/profile/1',
        attackCount: 1,
        raidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack'
    }, context, RAID_TWO.options.settings);
    assert.equal(unsafe, '[@everyone \\[x\\]\\(evil\\)](https://cw.x2.international.travian.com/alliance/members) — **+1 attack**\nNow: 1 attack / 0 raids');
    assert.ok(!unsafe.includes('evil.example.com'));

    assert.equal(script.truncateText('e\u0301x', 1), 'e\u0301');
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        assert.equal(script.truncateText('👨‍👩‍👧‍👦X', 1), '👨‍👩‍👧‍👦');
    }

    assert.equal(script.safeAllianceUrl('/alliance/1', context), ORIGIN + '/alliance/1');
    assert.equal(script.safeAllianceUrl('https://evil.example.com/x', context), FALLBACK_HREF);
    assert.equal(script.safeAllianceUrl('https://evil.example.com/x', {
        origin: ORIGIN,
        fallbackHref: '/alliance/fallback'
    }), ORIGIN + '/alliance/fallback');
    assert.throws(() => script.safeAllianceUrl('https://evil.example.com/x', {
        origin: ORIGIN,
        fallbackHref: 'https://evil.example.com/fallback'
    }), { name: 'TypeError', message: 'discord-alliance-url-unavailable' });
    assert.equal(
        script.safeAllianceUrl(ORIGIN + '/' + 'x'.repeat(2050), context),
        FALLBACK_HREF
    );
    assert.throws(() => script.safeAllianceUrl(FALLBACK_HREF, {
        origin: ORIGIN + '/not-an-origin',
        fallbackHref: FALLBACK_HREF
    }), { name: 'TypeError', message: 'discord-alliance-url-unavailable' });

    const valid = RAID_TWO.options.dispatchedAtMs;
    const invalidValues = [NaN, Infinity, -Infinity, 'not-a-time', null, undefined, 8.64e15 + 1];
    for (const value of invalidValues) {
        assert.deepEqual(script.buildCompactDiscordTiming(value, valid), {
            footer: { text: 'Observation time unavailable' },
            timestamp: new Date(valid).toISOString()
        });
        assert.deepEqual(script.buildCompactDiscordTiming(valid, value), {
            footer: { text: 'Observation time unavailable' }
        });
    }

    const zeroEvents = [
        { testId: 'zero', name: 'Zero', url: '/profile/8', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'attack', priority: 'normal' },
        { testId: 'join', name: 'Join', url: '/profile/9', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'join', priority: 'normal' }
    ];
    const zeroPresentation = script.buildCompactDiscordPresentation(zeroEvents, RAID_TWO.options);
    assert.equal(zeroPresentation.lineEntries.length, 2);
    assert.deepEqual(zeroPresentation.lineEntries.map(entry => entry.event.testId), ['zero', 'join']);
    assert.equal(zeroPresentation.lineEntries[0].line.endsWith('Now: 0 attacks / 0 raids'), true);
    assert.equal(zeroPresentation.summaryFields[0].value, 'No new activity');
    assert.equal(zeroPresentation.summaryFields[2].value, 'Normal');
});

test('compact grammar uses configured priority bands and stable unique identities', () => {
    const settings = script.validateSettings({
        attackThreshold: 1,
        raidThreshold: 1,
        normalMax: 1,
        highMax: 3
    });
    const events = [
        { testId: 'same-attack', playerId: '77', name: 'Same', url: '/profile/77', attackCount: 2, raidCount: 0, addedAttackCount: 2, addedRaidCount: 0, eventType: 'attack' },
        { testId: 'same-raid', playerId: '77', name: 'Same', url: '/profile/77', attackCount: 2, raidCount: 1, addedAttackCount: 0, addedRaidCount: 1, eventType: 'raid' },
        { testId: 'high', name: 'High Name', url: '/profile/78', attackCount: 4, raidCount: 0, addedAttackCount: 3, addedRaidCount: 0, eventType: 'attack' },
        { testId: 'critical', name: 'Critical Name', url: '/profile/79', attackCount: 7, raidCount: 0, addedAttackCount: 4, addedRaidCount: 0, eventType: 'attack' }
    ];
    const presentation = script.buildCompactDiscordPresentation(events, Object.assign({}, RAID_TWO.options, { settings }));
    assert.equal(presentation.baseTitle, '🚨 Alliance attack · 3 players');
    assert.deepEqual(presentation.lineEntries.map(entry => entry.event.testId), [
        'critical', 'high', 'same-attack', 'same-raid'
    ]);
    assert.equal(presentation.lineEntries[0].line.includes('Priority: Critical'), true);
    assert.equal(presentation.lineEntries[1].line.includes('Priority: High'), true);
    assert.equal(presentation.lineEntries[2].line.includes('Now: 2 attacks / 0 raids'), true);
    assert.deepEqual(presentation.summaryFields, [
        { name: 'New', value: '**+9 attacks** · **+1 raid**', inline: true },
        { name: 'Active now', value: '15 attacks / 1 raid', inline: true },
        { name: 'Priority', value: 'Critical', inline: true }
    ]);
});

test('compact timing distinguishes exact, approximate, missing, and future observations', () => {
    const dispatched = RAID_TWO.options.dispatchedAtMs;
    assert.deepEqual(script.buildCompactDiscordTiming(dispatched - 2000, dispatched), {
        footer: { text: 'Observed 2s before dispatch' },
        timestamp: new Date(dispatched).toISOString()
    });
    assert.deepEqual(script.buildCompactDiscordTiming(dispatched - 2000, dispatched, true), {
        footer: { text: 'Approximate observation' },
        timestamp: new Date(dispatched).toISOString()
    });
    assert.deepEqual(script.buildCompactDiscordTiming(undefined, dispatched), {
        footer: { text: 'Observation time unavailable' },
        timestamp: new Date(dispatched).toISOString()
    });
    assert.deepEqual(script.buildCompactDiscordTiming(dispatched + 1, dispatched), {
        footer: { text: 'Observation time unavailable' },
        timestamp: new Date(dispatched).toISOString()
    });
    const missingFromMonitorEnvelope = buildPayloads([
        discordEvent('Missing monitor timestamp', {
            attack: 1,
            raid: 0,
            addedAttack: 1,
            addedRaid: 0
        }, { observedAtMs: null })
    ], { observedAtMs: undefined });
        assert.equal(missingFromMonitorEnvelope[0].embeds[0].footer.text,
            `${HOST} · Observation time unavailable`);
});

test('compact titles omit zero deltas while rows retain both current counters', () => {
    const attackOnly = script.buildCompactDiscordPresentation([
        {
            testId: 'attack-with-raids-now',
            name: 'Attack with raids now',
            url: '/profile/81',
            attackCount: 2,
            raidCount: 4,
            addedAttackCount: 1,
            addedRaidCount: 0,
            eventType: 'attack'
        }
    ], RAID_TWO.options);
    assert.equal(attackOnly.baseTitle, '🚨 Alliance attack · 1 player');
    assert.equal(
        attackOnly.lineEntries[0].line,
        '[Attack with raids now](https://cw.x2.international.travian.com/profile/81) — **+1 attack**\nNow: 2 attacks / 4 raids'
    );

    const raidOnly = script.buildCompactDiscordPresentation([
        {
            testId: 'raid-with-attacks-now',
            name: 'Raid with attacks now',
            url: '/profile/82',
            attackCount: 4,
            raidCount: 2,
            addedAttackCount: 0,
            addedRaidCount: 1,
            eventType: 'raid'
        }
    ], RAID_TWO.options);
    assert.equal(raidOnly.baseTitle, '🛡️ Alliance raid · 1 player');
    assert.equal(
        raidOnly.lineEntries[0].line,
        '[Raid with attacks now](https://cw.x2.international.travian.com/profile/82) — **+1 raid**\nNow: 4 attacks / 2 raids'
    );

    const hostileWorld = script.buildCompactDiscordPresentation(
        RAID_TWO.events,
        Object.assign({}, RAID_TWO.options, {
            worldHostname: 'CW.X2.EXAMPLE.COM @everyone [world]'
        })
    );
    assert.equal(hostileWorld.footer.text, 'cw.x2.example.com-everyone-world · Observed <1s before dispatch');
    assert.equal(hostileWorld.footer.text.includes('@'), false);
});

function compactOptions(overrides = {}) {
    return Object.assign({}, RAID_TWO.options, overrides);
}

function bulkCompactEvents(count, startId = 301) {
    return Array.from({ length: count }, (_, index) => {
        const ordinal = String(index + 1).padStart(3, '0');
        const id = startId + index;
        return {
            testId: `bulk-${ordinal}`,
            name: `Bulk Player ${ordinal}`,
            url: `/profile/${id}`,
            attackCount: 52,
            raidCount: 17,
            addedAttackCount: 1,
            addedRaidCount: 0,
            eventType: 'attack',
            priority: 'normal'
        };
    });
}

function syntheticCompactPresentation(lineEntries, overrides = {}) {
    return Object.assign({
        baseTitle: 'T',
        eventClass: 'attack',
        allianceUrl: FALLBACK_HREF,
        color: 15158332,
        summaryFields: [
            { name: 'Active now', value: 'A', inline: true },
            { name: 'Priority', value: 'P', inline: true },
            { name: 'Observed', value: 'O', inline: true }
        ],
        lineEntries,
        footer: { text: 'F' },
        timestamp: '2026-08-23T09:46:01.000Z'
    }, overrides);
}

function syntheticLineEntries(lengths) {
    return lengths.map((length, index) => ({
        event: {
            testId: `synthetic-${index}`,
            name: `Synthetic ${index}`,
            url: `/profile/${index + 1}`,
            attackCount: 1,
            raidCount: 0,
            addedAttackCount: 1,
            addedRaidCount: 0,
            eventType: 'attack',
            priority: 'normal'
        },
        sourceIndex: index,
        line: 'x'.repeat(length)
    }));
}

function flattenedPlanTestIds(plans) {
    return plans.flatMap(plan => plan.embedPlans.flatMap(embedPlan =>
        embedPlan.lineEntries.map(entry => entry.event.testId)
    ));
}

function assertCompactPayloadShape(payloads, presentation, events) {
    const expectedLinks = new Set(events.map(event =>
        `${ORIGIN}${event.url}`
    ));
    const actualLinks = new Map();

    for (const payload of payloads) {
        assert.equal(payload.embeds.length <= script.DISCORD_EMBEDS_LIMIT, true);
        for (const [embedIndex, embed] of payload.embeds.entries()) {
            const first = embedIndex === 0;
            const last = embedIndex === payload.embeds.length - 1;

            if (first) {
                assert.deepEqual(embed.fields, presentation.summaryFields);
                assert.equal(embed.url, presentation.allianceUrl);
                assert.ok(embed.title.startsWith(presentation.baseTitle));
            } else {
                assert.equal('title' in embed, false);
                assert.equal('url' in embed, false);
                assert.equal('fields' in embed, false);
            }

            if (last) {
                assert.deepEqual(embed.footer, presentation.footer);
                assert.equal(embed.timestamp, presentation.timestamp);
            } else {
                assert.equal('footer' in embed, false);
                assert.equal('timestamp' in embed, false);
            }

            for (const event of events) {
                const link = `${ORIGIN}${event.url}`;
                if (embed.description.includes(link)) {
                    actualLinks.set(link, (actualLinks.get(link) || 0) + 1);
                }
            }
        }
    }

    assert.deepEqual(new Set(actualLinks.keys()), expectedLinks);
    for (const count of actualLinks.values()) {
        assert.equal(count, 1);
    }
    assert.equal(JSON.stringify(payloads).includes('testId'), false);
}

test('compact partition snapshots and identity', () => {
    assert.deepEqual(script.partitionCompactDiscordEntries(null), []);
    assert.deepEqual(script.buildDiscordPayloads([], RAID_TWO.options), []);

    const raidPresentation = script.buildCompactDiscordPresentation(
        RAID_TWO.events,
        RAID_TWO.options
    );
    const raidPlans = script.partitionCompactDiscordEntries(raidPresentation);
    assert.equal(raidPlans.length, 1);
    assert.deepEqual(flattenedPlanTestIds(raidPlans), [
        'raid-lenny',
        'raid-quinnos'
    ]);
    const raidPayloads = script.buildDiscordPayloads(
        RAID_TWO.events,
        RAID_TWO.options
    );
    assert.deepEqual(raidPayloads, [{
        content: '',
        username: 'Travian — attack alarm',
        embeds: [{
            title: '🛡️ Alliance raid · 2 players',
            url: FALLBACK_HREF,
            fields: [
                { name: 'New', value: '**+2 raids**', inline: true },
                { name: 'Active now', value: '0 attacks / 2 raids', inline: true },
                { name: 'Priority', value: 'Normal', inline: true }
            ],
            description: '**Players**\n' +
                '[Lenny Barre](https://cw.x2.international.travian.com/profile/101) — **+1 raid**\n' +
                'Now: 0 attacks / 1 raid\n\n' +
                '[Quinnos](https://cw.x2.international.travian.com/profile/102) — **+1 raid**\n' +
                'Now: 0 attacks / 1 raid',
            color: 15158332,
            footer: { text: `${HOST} · Observed <1s before dispatch` },
            timestamp: '2026-08-23T09:46:01.000Z'
        }],
        allowed_mentions: { users: [] }
    }]);

    const players60 = bulkCompactEvents(60, 301);
    const players60Presentation = script.buildCompactDiscordPresentation(
        players60,
        compactOptions({
            allianceUrl: FALLBACK_HREF,
            observedAtMs: RAID_TWO.options.observedAtMs,
            dispatchedAtMs: RAID_TWO.options.dispatchedAtMs
        })
    );
    const players60Plans = script.partitionCompactDiscordEntries(players60Presentation);
    const players60Payloads = script.buildDiscordPayloads(players60, compactOptions());
    assert.deepEqual(
        flattenedPlanTestIds(players60Plans),
        players60.map(event => event.testId)
    );
    assert.deepEqual(players60Payloads, script.buildDiscordPayloads(players60, compactOptions()));
    assertCompactPayloadShape(players60Payloads, players60Presentation, players60);
    assert.equal(players60Payloads.length > 0, true);

    const bulk512 = bulkCompactEvents(512, 1001);
    const bulk512Presentation = script.buildCompactDiscordPresentation(bulk512, RAID_TWO.options);
    const bulk512Plans = script.partitionCompactDiscordEntries(bulk512Presentation);
    assert.deepEqual(flattenedPlanTestIds(bulk512Plans), bulk512.map(event => event.testId));
    const bulk512Payloads = script.buildDiscordPayloads(bulk512, RAID_TWO.options);
    assert.deepEqual(bulk512Payloads, script.buildDiscordPayloads(bulk512, RAID_TWO.options));
    assertCompactPayloadShape(bulk512Payloads, bulk512Presentation, bulk512);

    const bulk513 = bulkCompactEvents(513, 2001);
    const bulk513Presentation = script.buildCompactDiscordPresentation(bulk513, RAID_TWO.options);
    const bulk513Plans = script.partitionCompactDiscordEntries(bulk513Presentation);
    assert.deepEqual(flattenedPlanTestIds(bulk513Plans), bulk513.map(event => event.testId));
    const bulk513Payloads = script.buildDiscordPayloads(bulk513, RAID_TWO.options);
    assert.deepEqual(bulk513Payloads, script.buildDiscordPayloads(bulk513, RAID_TWO.options));
    assertCompactPayloadShape(bulk513Payloads, bulk513Presentation, bulk513);

    const forced = Array.from({ length: 60 }, (_, index) => ({
        testId: `forced-${String(index).padStart(2, '0')}`,
        name: `Long Player ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
        url: `/profile/${401 + index}`,
        attackCount: 52,
        raidCount: 17,
        addedAttackCount: 1,
        addedRaidCount: 1,
        eventType: 'mixed',
        priority: 'high'
    }));
    const forcedPresentation = script.buildCompactDiscordPresentation(forced, RAID_TWO.options);
    const forcedPlans = script.partitionCompactDiscordEntries(forcedPresentation);
    const forcedPayloads = script.buildDiscordPayloads(forced, RAID_TWO.options);
    assert.equal(forcedPayloads.length > 1, true);
    assert.deepEqual(flattenedPlanTestIds(forcedPlans), forced.map(event => event.testId));
    const reserveWidth = String(forced.length).length;
    const reserve = ` · part ${'9'.repeat(reserveWidth)}/${'9'.repeat(reserveWidth)}`;
    forcedPayloads.forEach((payload, index) => {
        const title = payload.embeds[0].title;
        assert.equal(title, `${forcedPresentation.baseTitle} · part ${index + 1}/${forcedPayloads.length}`);
        assert.ok(title.length <= forcedPresentation.baseTitle.length + reserve.length);
    });
    assertCompactPayloadShape(forcedPayloads, forcedPresentation, forced);
    for (let index = 0; index < forcedPayloads.length; index += 1) {
        assert.deepEqual(
            forcedPayloads[index].embeds.at(-1).timestamp,
            forcedPresentation.timestamp
        );
    }
});

test('compact partition rejects one-unit overflow without loss', () => {
    const exactDescription = syntheticCompactPresentation(
        syntheticLineEntries([2041, 2041])
    );
    const exactPlans = script.partitionCompactDiscordEntries(exactDescription);
    assert.equal(exactPlans.length, 1);
    assert.equal(exactPlans[0].embedPlans[0].embed.description.length, 4096);

    const overDescription = syntheticCompactPresentation(
        syntheticLineEntries([2041, 2042])
    );
    const overDescriptionPlans = script.partitionCompactDiscordEntries(overDescription);
    assert.equal(overDescriptionPlans.length, 1);
    assert.equal(overDescriptionPlans[0].embedPlans.length, 2);
    assert.deepEqual(flattenedPlanTestIds(overDescriptionPlans), [
        'synthetic-0',
        'synthetic-1'
    ]);

    const exactAggregate = syntheticCompactPresentation(
        syntheticLineEntries([1454, 1454]),
        {
            summaryFields: [
                { name: 'N', value: 'x'.repeat(1023), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true }
            ]
        }
    );
    const exactAggregatePlans = script.partitionCompactDiscordEntries(exactAggregate);
    assert.equal(exactAggregatePlans.length, 1);
    assert.equal(
        script.measureDiscordEmbedText(exactAggregatePlans[0].embedPlans.map(plan => plan.embed)),
        5998
    );

    const overAggregate = syntheticCompactPresentation(
        syntheticLineEntries([2000, 2000]),
        {
            summaryFields: [
                { name: 'N', value: 'x'.repeat(1023), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true }
            ]
        }
    );
    const overAggregatePlans = script.partitionCompactDiscordEntries(overAggregate);
    assert.equal(overAggregatePlans.length, 2);
    assert.deepEqual(flattenedPlanTestIds(overAggregatePlans), [
        'synthetic-0',
        'synthetic-1'
    ]);

    const worstEvent = {
        testId: 'worst',
        name: '\\`*_{}[]()~>#+-.!|'.repeat(8),
        url: '/profile/' + '9'.repeat(400),
        attackCount: 1,
        raidCount: 1,
        addedAttackCount: 1,
        addedRaidCount: 1,
        eventType: 'mixed',
        priority: 'normal'
    };
    const worstPresentation = script.buildCompactDiscordPresentation(
        [worstEvent],
        RAID_TWO.options
    );
    const worstPlans = script.partitionCompactDiscordEntries(worstPresentation);
    assert.equal(worstPlans.length, 1);
    assert.ok(worstPlans[0].embedPlans[0].embed.description.length <= 4096);
    assert.ok(script.measureDiscordEmbedText(worstPlans[0].embedPlans.map(plan => plan.embed)) <= 6000);

    const invalidEntry = syntheticLineEntries([5000])[0];
    invalidEntry.event.name = 'N'.repeat(script.EVENT_NAME_MAX + 1);
    invalidEntry.event.url = '/profile/' + '9'.repeat(script.EVENT_URL_MAX + 1);
    const invalidPresentation = syntheticCompactPresentation([invalidEntry]);
    let partialPlan;
    assert.throws(() => {
        partialPlan = script.partitionCompactDiscordEntries(invalidPresentation);
    }, { name: 'RangeError', message: 'discord-row-over-budget' });
    assert.equal(partialPlan, undefined);
});

test('compact partition enforces exact Discord title, field, total, and content budgets', () => {
    const titleReserve = ' · part 9/9';
    const exactTitle = syntheticCompactPresentation(
        syntheticLineEntries([3000, 3000]),
        { baseTitle: 'T'.repeat(256 - titleReserve.length) }
    );
    const exactTitlePlans = script.partitionCompactDiscordEntries(exactTitle);
    assert.equal(
        exactTitlePlans[0].embedPlans[0].embed.title.length,
        256
    );

    const overTitle = syntheticCompactPresentation(
        syntheticLineEntries([3000, 3000]),
        { baseTitle: 'T'.repeat(257 - titleReserve.length) }
    );
    assert.throws(
        () => script.partitionCompactDiscordEntries(overTitle),
        { name: 'RangeError', message: 'discord-row-over-budget' }
    );

    const exactFieldName = syntheticCompactPresentation(
        syntheticLineEntries([1]),
        {
            summaryFields: [
                { name: 'N'.repeat(256), value: 'v', inline: true },
                { name: 'N', value: 'v', inline: true },
                { name: 'N', value: 'v', inline: true }
            ]
        }
    );
    assert.equal(script.partitionCompactDiscordEntries(exactFieldName).length, 1);

    const overFieldName = syntheticCompactPresentation(
        syntheticLineEntries([1]),
        {
            summaryFields: [
                { name: 'N'.repeat(257), value: 'v', inline: true },
                { name: 'N', value: 'v', inline: true },
                { name: 'N', value: 'v', inline: true }
            ]
        }
    );
    assert.throws(
        () => script.partitionCompactDiscordEntries(overFieldName),
        { name: 'RangeError', message: 'discord-row-over-budget' }
    );

    const exactFieldValue = syntheticCompactPresentation(
        syntheticLineEntries([1]),
        {
            summaryFields: [
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'v', inline: true },
                { name: 'N', value: 'v', inline: true }
            ]
        }
    );
    assert.equal(script.partitionCompactDiscordEntries(exactFieldValue).length, 1);

    const overFieldValue = syntheticCompactPresentation(
        syntheticLineEntries([1]),
        {
            summaryFields: [
                { name: 'N', value: 'x'.repeat(1025), inline: true },
                { name: 'N', value: 'v', inline: true },
                { name: 'N', value: 'v', inline: true }
            ]
        }
    );
    assert.throws(
        () => script.partitionCompactDiscordEntries(overFieldValue),
        { name: 'RangeError', message: 'discord-row-over-budget' }
    );

    const exactTotal = syntheticCompactPresentation(
        syntheticLineEntries([1454, 1455]),
        {
            summaryFields: [
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true }
            ]
        }
    );
    const exactTotalPlans = script.partitionCompactDiscordEntries(exactTotal);
    assert.equal(
        script.measureDiscordEmbedText(exactTotalPlans[0].embedPlans.map(plan => plan.embed)),
        6000
    );

    const overTotal = syntheticCompactPresentation(
        syntheticLineEntries([1454, 1456]),
        {
            summaryFields: [
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true },
                { name: 'N', value: 'x'.repeat(1024), inline: true }
            ]
        }
    );
    const overTotalPlans = script.partitionCompactDiscordEntries(overTotal);
    assert.equal(overTotalPlans.length, 2);
    assert.equal(overTotalPlans[0].embedPlans.length, 1);
    assert.equal(overTotalPlans[1].embedPlans.length, 1);

    const ids = Array.from({ length: 87 }, (_, index) => index < 58
        ? String(10000000000000000000n + BigInt(index))
        : String(10000000000000000n + BigInt(index - 58))
    );
    const exactContent = script.buildMentionContent(null, ids);
    assert.equal(exactContent.length, 2000);
    assert.equal(
        script.buildMentionContent(null, ids.concat(['2'.repeat(17)])).length,
        2000
    );
});

test('compact production mentions and legacy cleanup', () => {
    const events = Array.from({ length: 60 }, (_, index) => ({
        testId: `todo3-attack-${index}`,
        name: `Todo 3 Attack ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
        url: `/profile/${7001 + index}`,
        attackCount: 52,
        raidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack',
        priority: 'high'
    }));
    const options = compactOptions({
        roleId: ROLE,
        userIds: [UID_A, UID_B]
    });
    const payloads = script.buildDiscordPayloads(events, options);

    assert.ok(payloads.length > 1, 'forced attack batch must split');
    assert.equal(payloads[0].content, `<@&${ROLE}> <@${UID_A}> <@${UID_B}>`);
    assert.deepEqual(payloads[0].allowed_mentions, {
        users: [UID_A, UID_B],
        roles: [ROLE]
    });
    for (let index = 1; index < payloads.length; index += 1) {
        assert.equal(payloads[index].content, '');
        assert.deepEqual(payloads[index].allowed_mentions, { users: [] });
        assert.equal('roles' in payloads[index].allowed_mentions, false);
        assert.equal('parse' in payloads[index].allowed_mentions, false);
        assert.equal(JSON.stringify(payloads[index]).includes(ROLE), false);
        assert.equal(JSON.stringify(payloads[index]).includes(UID_A), false);
        assert.equal(JSON.stringify(payloads[index]).includes(UID_B), false);
        assert.notEqual(payloads[index].allowed_mentions, payloads[index - 1].allowed_mentions);
    }

    const raidPayloads = script.buildDiscordPayloads(
        events.slice(0, 2).map((event, index) => Object.assign({}, event, {
            testId: `todo3-raid-${index}`,
            eventType: 'raid',
            attackCount: 0,
            raidCount: 3,
            addedAttackCount: 0,
            addedRaidCount: 1
        })),
        options
    );
    assert.deepEqual(raidPayloads[0].allowed_mentions, { users: [UID_A, UID_B] });
    assert.equal('roles' in raidPayloads[0].allowed_mentions, false);

    const source = fs.readFileSync(require.resolve('../script.txt'), 'utf8');
    assert.equal((source.match(/function\s+buildDiscordPayloads\s*\(/g) || []).length, 1);
    assert.equal((source.match(/function\s+serializeCompactDiscordRequestPlans\s*\(/g) || []).length, 1);
    for (const removed of [
        'summarizeEventTypes',
        'buildDispatchedFieldValue',
        'summarizePlayerProfiles'
    ]) {
        assert.equal(removed in script, false, `${removed} should not be exported`);
    }
    assert.equal(typeof script.buildProfileLink, 'function');
    assert.equal(typeof script.priorityLabel, 'function');
});

test('compact mentions reject invalid ids and silence continuations', () => {
    const events = Array.from({ length: 60 }, (_, index) => ({
        testId: `todo3-invalid-${index}`,
        name: `Invalid Mention Attack ${String(index).padStart(2, '0')} ${'y'.repeat(80)}`,
        url: `/profile/${7101 + index}`,
        attackCount: 40,
        raidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack',
        priority: 'normal'
    }));
    const invalidIds = [
        `<@${UID_B}>`,
        'abc',
        ' 1234567890123456 ',
        123456789012345678
    ];
    const payloads = script.buildDiscordPayloads(events, compactOptions({
        roleId: ROLE,
        userIds: [UID_A, ...invalidIds]
    }));

    assert.ok(payloads.length > 1, 'invalid-ID batch must still split');
    assert.equal(payloads[0].content, `<@&${ROLE}> <@${UID_A}>`);
    assert.deepEqual(payloads[0].allowed_mentions, {
        users: [UID_A],
        roles: [ROLE]
    });
    for (const invalidId of invalidIds) {
        assert.equal(payloads[0].content.includes(String(invalidId)), false);
    }

    for (let index = 1; index < payloads.length; index += 1) {
        assert.equal(payloads[index].content, '');
        assert.deepEqual(payloads[index].allowed_mentions, { users: [] });
        assert.equal('roles' in payloads[index].allowed_mentions, false);
        assert.equal('parse' in payloads[index].allowed_mentions, false);
    }

    for (const event of events) {
        const link = `](${ORIGIN}${event.url})`;
        const occurrences = payloads.reduce(
            (count, payload) => count + payload.embeds.reduce(
                (embedCount, embed) => embedCount +
                    (embed.description.includes(link) ? 1 : 0),
                0
            ),
            0
        );
        assert.equal(occurrences, 1, `row ${event.testId} must appear once`);
    }
});

test('5.2 attack hierarchy: titles fields players and footer', () => {
    const attack = buildPayloads([
        discordEvent('Solo', { attack: 7, raid: 0, addedAttack: 2, addedRaid: 0 })
    ]);
    const raid = buildPayloads([
        discordEvent('Raider', { attack: 0, raid: 5, addedAttack: 0, addedRaid: 1 })
    ]);
    const mixed = buildPayloads([
        discordEvent('Mixed', { attack: 8, raid: 1, addedAttack: 1, addedRaid: 1 })
    ]);
    const roster = buildPayloads([
        Object.assign(discordEvent('Joiner 11', { attack: 0, raid: 0, addedAttack: 0, addedRaid: 0 }), { eventType: 'join' }),
        Object.assign(discordEvent('Leaver 12', { attack: 0, raid: 0, addedAttack: 0, addedRaid: 0 }), { eventType: 'leave' })
    ]);

    assert.equal(attack[0].embeds[0].title, '🚨 Alliance attack · 1 player');
    assert.equal(raid[0].embeds[0].title, '🛡️ Alliance raid · 1 player');
    assert.equal(mixed[0].embeds[0].title, '🚨 Alliance attack · 1 player');
    assert.equal(roster[0].embeds[0].title, '🔄 Alliance changes · 2 players');

    assert.deepEqual(attack[0].embeds[0].fields, [
        { name: 'New', value: '**+2 attacks**', inline: true },
        { name: 'Active now', value: '7 attacks / 0 raids', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
    assert.deepEqual(roster[0].embeds[0].fields, [
        { name: 'New', value: '**1 joined** · **1 left**', inline: true },
        { name: 'Active now', value: '—', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
    assert.equal(
        mixed[0].embeds[0].description,
        '**Players**\n' +
        '[Mixed](https://cw.x2.international.travian.com/profile/1) — **+1 attack** · **+1 raid**\n' +
        'Now: 8 attacks / 1 raid'
    );
    assert.equal(roster[0].embeds[0].description, '**Players**\n' +
        '[Joiner 11](https://cw.x2.international.travian.com/profile/11) — joined the alliance\n\n' +
        '[Leaver 12](https://cw.x2.international.travian.com/profile/12) — left the alliance');
    assert.equal(
        attack[0].embeds[0].footer.text,
        `${HOST} · Observed 2s before dispatch`
    );
    assert.equal(attack[0].embeds[0].timestamp, '2026-08-23T23:03:14.000Z');
    assert.equal(JSON.stringify(attack).includes('Observed"'), false);
});

test('5.2 attack hierarchy: multiline partition remains bounded and lossless', () => {
    const events = Array.from({ length: 60 }, (_, index) => discordEvent(
        `Unicode ${String(index + 1).padStart(2, '0')} 👨‍👩‍👧‍👦 ${'🛡️'.repeat(18)}`,
        { attack: 52, raid: 17, addedAttack: 1, addedRaid: 1 }
    ));
    const payloads = buildPayloads(events);
    const occurrences = new Map(events.map(event => [event.name, 0]));

    for (const payload of payloads) {
        assertDiscordPayloadLimits([payload]);
        for (const embed of payload.embeds) {
            for (const event of events) {
                if (embed.description.includes(event.name)) {
                    occurrences.set(event.name, occurrences.get(event.name) + 1);
                }
            }
        }
        assert.equal(payload.embeds[0].fields.length, 3);
        assert.equal(payload.embeds.at(-1).timestamp, '2026-08-23T23:03:14.000Z');
        assert.equal(payload.embeds.at(-1).footer.text, `${HOST} · Observed 2s before dispatch`);
    }
    assert.deepEqual([...occurrences.values()], events.map(() => 1));
    assert.ok(payloads.length <= 3, `fan-out must remain bounded: ${payloads.length}`);

    for (const count of [9, 10]) {
        const presentation = syntheticCompactPresentation(
            syntheticLineEntries(Array.from({ length: count }, () => 3000))
        );
        const plans = script.partitionCompactDiscordEntries(presentation);
        assert.equal(plans.length, count);
        assert.equal(plans[8].embedPlans[0].embed.title, `${presentation.baseTitle} · part 9/${count}`);
        if (count === 10) {
            assert.equal(plans[9].embedPlans[0].embed.title, `${presentation.baseTitle} · part 10/10`);
        }
    }
});

test('5.2 attack hierarchy: hostile markdown overflow and duplicate mentions fail safe', () => {
    const hostile = buildPayloads([
        discordEvent('`*_[]()~>#+-.!| @everyone [x](https://evil.example)', {
            attack: 1,
            raid: 0,
            addedAttack: 1,
            addedRaid: 0
        }, { url: 'https://evil.example.com/profile/1' })
    ], { roleId: ROLE, userIds: [UID_A, UID_A, '<@123>', 'not-a-snowflake'] });
    const hostileText = JSON.stringify(hostile);
    assert.equal(hostileText.includes('https://evil.example.com'), false);
    assert.equal(hostile[0].embeds[0].description.includes(']('), true);
    assert.equal(hostile[0].embeds[0].description.includes('\\[x\\]'), true);
    assert.deepEqual(hostile[0].allowed_mentions, { users: [UID_A], roles: [ROLE] });

    const events = Array.from({ length: 60 }, (_, index) => discordEvent(
        `Overflow ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
        { attack: 52, raid: 17, addedAttack: 1, addedRaid: 0 }
    ));
    const payloads = buildPayloads(events, { roleId: ROLE, userIds: [UID_A] });
    assert.ok(payloads.length > 1);
    for (const payload of payloads.slice(1)) {
        assert.equal(payload.content, '');
        assert.deepEqual(payload.allowed_mentions, { users: [] });
        assert.equal(JSON.stringify(payload).includes(ROLE), false);
        assert.equal(JSON.stringify(payload).includes(UID_A), false);
    }
    assert.equal(script.truncateText('😀X', 1), '😀');
    assert.equal(script.truncateText('😀X', 2), '😀X');

    const impossible = syntheticCompactPresentation(syntheticLineEntries([4090]));
    assert.throws(
        () => script.partitionCompactDiscordEntries(impossible),
        { name: 'RangeError', message: 'discord-row-over-budget' }
    );
});

test('Discord grammar: screenshot-equivalent deltas lead one request', () => {
    const observedAtMs = Date.UTC(2026, 7, 23, 23, 3, 12);
    const dispatchedAtMs = Date.UTC(2026, 7, 23, 23, 3, 14);
    const events = [
        discordEvent('Player 365', { attack: 17, raid: 5, addedAttack: 2, addedRaid: 0 }, { observedAtMs, dispatchedAtMs }),
        discordEvent('sandla', { attack: 7, raid: 7, addedAttack: 2, addedRaid: 0 }, { observedAtMs, dispatchedAtMs }),
        discordEvent('Ariadne', { attack: 8, raid: 1, addedAttack: 1, addedRaid: 1 }, { observedAtMs, dispatchedAtMs }),
        discordEvent('Borek', { attack: 6, raid: 2, addedAttack: 1, addedRaid: 1 }, { observedAtMs, dispatchedAtMs }),
        discordEvent('Ciri', { attack: 7, raid: 1, addedAttack: 1, addedRaid: 1 }, { observedAtMs, dispatchedAtMs }),
        discordEvent('Darek', { attack: 7, raid: 1, addedAttack: 1, addedRaid: 0 }, { observedAtMs, dispatchedAtMs })
    ];

    const payloads = buildPayloads(events, { observedAtMs, dispatchedAtMs });

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].content, '');
    assert.deepEqual(payloads[0].allowed_mentions, { users: [] });
    assert.equal(payloads[0].embeds.length, 1);
    assert.equal(
        payloads[0].embeds[0].title,
        '🚨 Alliance attack · 2 players'
    );
    assert.equal(
        payloads[0].embeds[0].description,
        '**Players**\n' +
        '[Player 365](https://cw.x2.international.travian.com/profile/365) — **+2 attacks**\nNow: 17 attacks / 5 raids\n\n' +
        '[sandla](https://cw.x2.international.travian.com/profile/1) — **+2 attacks**\nNow: 7 attacks / 7 raids\n\n' +
        '[Ariadne](https://cw.x2.international.travian.com/profile/1) — **+1 attack** · **+1 raid**\nNow: 8 attacks / 1 raid\n\n' +
        '[Borek](https://cw.x2.international.travian.com/profile/1) — **+1 attack** · **+1 raid**\nNow: 6 attacks / 2 raids\n\n' +
        '[Ciri](https://cw.x2.international.travian.com/profile/1) — **+1 attack** · **+1 raid**\nNow: 7 attacks / 1 raid\n\n' +
        '[Darek](https://cw.x2.international.travian.com/profile/1) — **+1 attack**\nNow: 7 attacks / 1 raid'
    );
    assert.deepEqual(payloads[0].embeds[0].fields, [
        { name: 'New', value: '**+8 attacks** · **+3 raids**', inline: true },
        { name: 'Active now', value: '52 attacks / 17 raids', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
    assert.deepEqual(payloads[0].embeds[0].footer, {
        text: `${HOST} · Observed 2s before dispatch`
    });
    assert.equal(payloads[0].embeds[0].timestamp, '2026-08-23T23:03:14.000Z');
    assert.ok(!JSON.stringify(payloads[0]).includes('Visible attacks'));
    assert.ok(!JSON.stringify(payloads[0]).includes('Attacked players'));
});

function userFacingPayloadSnapshot(payloads) {
    return payloads.map(payload => ({
        content: payload.content,
        allowed_mentions: payload.allowed_mentions,
        embeds: payload.embeds.map(embed => ({
            title: embed.title,
            description: embed.description,
            fields: embed.fields
        }))
    }));
}

function assertDiscordPayloadLimits(payloads) {
    for (const payload of payloads) {
        assert.ok(payload.content.length <= script.DISCORD_CONTENT_LIMIT);
        assert.ok(payload.embeds.length <= script.DISCORD_EMBEDS_LIMIT);

        let totalText = 0;
        for (const embed of payload.embeds) {
            assert.ok(embed.description.length <= script.EMBED_DESCRIPTION_LIMIT);
            if (embed.title) {
                assert.ok(embed.title.length <= 256);
            }
            totalText += (embed.title || '').length + embed.description.length;
            for (const field of embed.fields || []) {
                assert.ok(field.name.length <= 256);
                assert.ok(field.value.length <= script.EMBED_FIELD_VALUE_LIMIT);
                totalText += field.name.length + field.value.length;
            }
            totalText += (embed.footer && embed.footer.text || '').length;
        }
        assert.ok(totalText <= script.EMBED_TOTAL_TEXT_LIMIT);
    }
}

test('Task 7: deterministic dispatch plan partitions 25 source IDs exactly once', () => {
    const events = Array.from({ length: 25 }, (_, index) => ({
        eventId: `event-${index + 1}`,
        sourceEventIds: [`s1:source-${String(index + 1).padStart(2, '0')}`],
        addedAttackCount: 1,
        addedRaidCount: index % 2
    }));
    const first = script.buildDispatchPlanV1(events, { chunkSize: 7 });
    const second = script.buildDispatchPlanV1([...events].reverse(), { chunkSize: 7 });
    assert.deepEqual(first, second);
    assert.equal(first.chunks.length, 4);
    const ids = first.chunks.flatMap(chunk => chunk.sourceEventIds);
    assert.equal(new Set(ids).size, 25);
    assert.deepEqual(ids.sort(), events.flatMap(event => event.sourceEventIds).sort());
    assert.ok(first.batchId.startsWith('b1:'));
    assert.ok(first.chunks.every(chunk => chunk.chunkId.startsWith('c1:')));
});

test('Task 7: chunk transitions preserve attempts, fencing, and uncertain delivery', () => {
    const plan = script.buildDispatchPlanV1([
        { eventId: 'one', sourceEventIds: ['s1:one'], addedAttackCount: 1, addedRaidCount: 0 },
        { eventId: 'two', sourceEventIds: ['s1:two'], addedAttackCount: 0, addedRaidCount: 1 }
    ], { chunkSize: 2 });
    const prepared = script.applyDispatchPlanTransitionV1(plan, { type: 'claim', ownerId: 'tab-a', term: 3, generation: 0 });
    assert.equal(prepared.chunks[0].state, 'sending');
    assert.equal(prepared.chunks[0].attempt, 1);
    const retryable = script.applyDispatchPlanTransitionV1(prepared, {
        type: 'response', chunkId: prepared.chunks[0].chunkId, ownerId: 'tab-a', term: 3,
        generation: prepared.generation, status: 429, retryAtMs: 1234
    });
    assert.equal(retryable.chunks[0].state, 'retryable');
    assert.equal(retryable.chunks[0].attempt, 1);
    const claimed = script.applyDispatchPlanTransitionV1(retryable, { type: 'claim', ownerId: 'tab-a', term: 3, generation: retryable.generation });
    const uncertain = script.applyDispatchPlanTransitionV1(claimed, {
        type: 'response', chunkId: claimed.chunks[0].chunkId, ownerId: 'tab-a', term: 3,
        generation: claimed.generation, status: 200
    });
    assert.equal(uncertain.chunks[0].state, 'uncertain');
    assert.equal(script.applyDispatchPlanTransitionV1(uncertain, { type: 'claim', ownerId: 'tab-a', term: 3, generation: uncertain.generation }), null);
});

test('Task 7: retry, permanent failure, and stale fence never lose chunk membership', () => {
    const plan = script.buildDispatchPlanV1([{ sourceEventIds: ['s1:only'], addedAttackCount: 2, addedRaidCount: 0 }], { chunkSize: 1 });
    const sending = script.applyDispatchPlanTransitionV1(plan, { type: 'claim', ownerId: 'owner', term: 4, generation: 0 });
    assert.equal(script.applyDispatchPlanTransitionV1(sending, { type: 'response', chunkId: sending.chunks[0].chunkId, ownerId: 'stale', term: 4, generation: sending.generation, status: 200, messageId: 'm' }), null);
    const failed = script.applyDispatchPlanTransitionV1(sending, { type: 'response', chunkId: sending.chunks[0].chunkId, ownerId: 'owner', term: 4, generation: sending.generation, status: 400 });
    assert.equal(failed.chunks[0].state, 'failed');
    assert.deepEqual(failed.chunks[0].sourceEventIds, ['s1:only']);
});

test('Task 7 rejection: malformed 200 and lease recovery are uncertain and not automatic', () => {
    const plan = script.buildDispatchPlanV1([{ sourceEventIds: ['s1:only'], addedAttackCount: 1, addedRaidCount: 0 }], { chunkSize: 1 });
    const sending = script.applyDispatchPlanTransitionV1(plan, { type: 'claim', ownerId: 'owner', term: 1, generation: 0 });
    const recovered = script.applyDispatchPlanTransitionV1(sending, { type: 'recover', chunkId: sending.chunks[0].chunkId, generation: sending.generation, responseClass: 'response-lost' });
    assert.equal(recovered.chunks[0].state, 'uncertain');
    assert.equal(script.applyDispatchPlanTransitionV1(recovered, { type: 'claim', ownerId: 'owner', term: 1, generation: recovered.generation }), null);
});

test('Discord grammar: one-player, raid-only, and mixed snapshots are exact', () => {
    const attack = buildPayloads([
        discordEvent('Solo', { attack: 4, raid: 0, addedAttack: 1, addedRaid: 0 })
    ]);
    const raid = buildPayloads([
        discordEvent('Raider', { attack: 0, raid: 4, addedAttack: 0, addedRaid: 1 })
    ]);
    const mixed = buildPayloads([
        discordEvent('Mixed', { attack: 4, raid: 2, addedAttack: 1, addedRaid: 1 })
    ]);

    assert.deepEqual(userFacingPayloadSnapshot(attack), [{
        content: '',
        allowed_mentions: { users: [] },
        embeds: [{
                title: '🚨 Alliance attack · 1 player',
            description: '**Players**\n' +
                '[Solo](https://cw.x2.international.travian.com/profile/1) — **+1 attack**\nNow: 4 attacks / 0 raids',
            fields: [
                { name: 'New', value: '**+1 attack**', inline: true },
                { name: 'Active now', value: '4 attacks / 0 raids', inline: true },
                { name: 'Priority', value: 'Normal', inline: true }
            ]
        }]
    }]);
    assert.deepEqual(userFacingPayloadSnapshot(raid), [{
        content: '',
        allowed_mentions: { users: [] },
        embeds: [{
                title: '🛡️ Alliance raid · 1 player',
            description: '**Players**\n' +
                '[Raider](https://cw.x2.international.travian.com/profile/1) — **+1 raid**\nNow: 0 attacks / 4 raids',
            fields: [
                { name: 'New', value: '**+1 raid**', inline: true },
                { name: 'Active now', value: '0 attacks / 4 raids', inline: true },
                { name: 'Priority', value: 'Normal', inline: true }
            ]
        }]
    }]);
    assert.equal(mixed[0].embeds[0].title, '🚨 Alliance attack · 1 player');
    assert.equal(mixed[0].embeds[0].description, '**Players**\n' +
        '[Mixed](https://cw.x2.international.travian.com/profile/1) — **+1 attack** · **+1 raid**\nNow: 4 attacks / 2 raids');
    assert.deepEqual(mixed[0].embeds[0].fields, [
        { name: 'New', value: '**+1 attack** · **+1 raid**', inline: true },
        { name: 'Active now', value: '4 attacks / 2 raids', inline: true },
        { name: 'Priority', value: 'Normal', inline: true }
    ]);
});

test('Discord grammar: 60 players pack deterministically and preserve every event', () => {
    const events = Array.from({ length: 60 }, (_, index) => discordEvent(
        `Player ${String(index + 1).padStart(2, '0')}`,
        { attack: 52, raid: 17, addedAttack: 1, addedRaid: 0 }
    ));
    const payloads = buildPayloads(events);
    const repeated = buildPayloads(events);

    assert.deepEqual(payloads, repeated);
    assert.equal(payloads.length > 1, true);
    assert.ok(payloads[0].embeds[0].title.startsWith('🚨 Alliance attack · 60 players · part '));
    for (const event of events) {
        const occurrences = payloads.reduce(
            (count, payload) => count + payload.embeds.reduce(
                (inner, embed) => inner + (embed.description.includes(event.name) ? 1 : 0),
                0
            ),
            0
        );
        assert.equal(occurrences, 1, `event appears once: ${event.name}`);
    }
    assertDiscordPayloadLimits(payloads);
});

test('Discord grammar: Unicode names stay escaped, capped, and unbroken', () => {
    const name = '😀界e\u0301—' + '🛡️'.repeat(40);
    const payloads = buildPayloads([
        discordEvent(name, { attack: 2, raid: 1, addedAttack: 1, addedRaid: 1 })
    ]);
    const description = payloads[0].embeds[0].description;

    assert.ok(description.includes('😀'));
    assert.ok(!description.includes('evil.example.com'));
    assert.ok(description.includes('· **+1 raid**'));
    assert.ok(script.truncateText(name, script.EVENT_NAME_MAX).length > 0);
    assertDiscordPayloadLimits(payloads);
    assert.equal(payloads[0].embeds.length, 1);
});

test('Discord grammar: mentions remain allowlisted when content is truncated', () => {
    const userIds = Array.from({ length: 180 }, (_, index) => String(10000000000000000000n + BigInt(index)));
    const payloads = buildPayloads([
        discordEvent('Mentioned', { attack: 1, raid: 0, addedAttack: 1, addedRaid: 0 })
    ], { roleId: ROLE, userIds });
    const payload = payloads[0];

    assert.ok(payload.content.length <= script.DISCORD_CONTENT_LIMIT);
    assert.deepEqual(payload.allowed_mentions.users, script.selectMentions(ROLE, userIds).userIds);
    assert.deepEqual(payload.allowed_mentions.roles, [ROLE]);
    assert.equal('parse' in payload.allowed_mentions, false);
});

test('Discord grammar: aggregate boundary splits requests without loss', () => {
    const events = Array.from({ length: 60 }, (_, index) => discordEvent(
        `Long Player ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
        { attack: 52, raid: 17, addedAttack: 1, addedRaid: 1 }
    ));
    const payloads = buildPayloads(events);

    assert.ok(payloads.length > 1, 'aggregate embed text forces a second request');
    assertDiscordPayloadLimits(payloads);
    for (const event of events) {
        const safeName = script.truncateText(event.name, script.EVENT_NAME_MAX);
        const occurrences = payloads.reduce(
            (count, payload) => count + payload.embeds.reduce(
                (inner, embed) => inner + (embed.description.includes(safeName) ? 1 : 0),
                0
            ),
            0
        );
        assert.equal(occurrences, 1, `boundary event appears once: ${safeName}`);
    }
});

test('limity payloadu: stałe i eksporty', () => {
    assert.equal(script.DISCORD_CONTENT_LIMIT, 2000);
    assert.equal(script.EMBED_DESCRIPTION_LIMIT, 4096);
    assert.equal(script.EMBED_FIELD_VALUE_LIMIT, 1024);
    assert.equal(script.EMBED_TOTAL_TEXT_LIMIT, 6000);
    assert.equal(script.DISCORD_EMBEDS_LIMIT, 10);
    assert.equal(script.EVENT_NAME_MAX, 80);
    assert.equal(script.EVENT_URL_MAX, 300);

    for (const name of [
        'DISCORD_CONTENT_LIMIT',
        'EMBED_DESCRIPTION_LIMIT',
        'EMBED_FIELD_VALUE_LIMIT',
        'EMBED_TOTAL_TEXT_LIMIT',
        'DISCORD_EMBEDS_LIMIT',
        'EMBED_DESCRIPTION_SAFE_BUDGET',
        'EMBED_TOTAL_SAFE_BUDGET',
        'EVENT_NAME_MAX',
        'EVENT_URL_MAX',
        'truncateText',
        'encodeMarkdownUrl',
        'safeProfileUrl',
        'selectMentions',
        'buildEventDescriptionLine',
        'measureDiscordEmbedText',
        'partitionCompactDiscordEntries',
        'buildDiscordPayloads',
        'buildProfileLink',
        'chunkEventsForDiscord'
    ]) {
        assert.ok(name in script, 'brak eksportu ' + name);
    }
});

test('truncateText: cap znaków, kod-punktowo, brzegi', () => {
    assert.equal(script.truncateText('abcdef', 3), 'abc');
    assert.equal(script.truncateText('abc', 3), 'abc');
    assert.equal(script.truncateText('abc', 100), 'abc');
    assert.equal(script.truncateText('', 3), '');
    assert.equal(script.truncateText(null, 3), '');
    assert.equal(script.truncateText(undefined, 3), '');
    assert.equal(script.truncateText('abc', 0), '');
    assert.equal(script.truncateText('abc', -5), '');
    assert.equal(script.truncateText('abc', NaN), '');
    // emoji (surrogate pair) nie jest rozcinane w połowie
    assert.equal(script.truncateText('a😀b', 2), 'a😀');
    assert.equal(script.truncateText('😀😀😀', 2), '😀😀');
    assert.equal(script.truncateText('e\u0301x', 1), 'e\u0301');
});

test('encodeMarkdownUrl: ucieka znaki łamiące link, reszta nietknięta', () => {
    assert.equal(
        script.encodeMarkdownUrl('https://x.test/a(b)'),
        'https://x.test/a\\(b\\)'
    );
    assert.equal(
        script.encodeMarkdownUrl('https://x.test/a b'),
        'https://x.test/a\\ b'
    );
    assert.equal(
        script.encodeMarkdownUrl('https://x.test/back\\slash'),
        'https://x.test/back\\\\slash'
    );
    assert.equal(
        script.encodeMarkdownUrl('https://x.test/a<b>'),
        'https://x.test/a\\<b\\>'
    );
    assert.equal(
        script.encodeMarkdownUrl('https://x.test/profile/385?uid=1&x=2'),
        'https://x.test/profile/385?uid=1&x=2'
    );
    assert.equal(script.encodeMarkdownUrl(''), '');
    assert.equal(script.encodeMarkdownUrl(null), '');
});

test('safeProfileUrl: tylko bieżący origin, obcy -> fallback', () => {
    const ctx = { origin: ORIGIN, fallbackHref: FALLBACK_HREF };

    assert.equal(
        script.safeProfileUrl(
            'https://cw.x2.international.travian.com/profile/385',
            ctx
        ),
        'https://cw.x2.international.travian.com/profile/385'
    );
    assert.equal(
        script.safeProfileUrl('/profile/385', ctx),
        'https://cw.x2.international.travian.com/profile/385',
        'względny URL rozwiązywany względem originu'
    );
    assert.equal(
        script.safeProfileUrl('https://evil.example.com/x', ctx),
        FALLBACK_HREF,
        'obca domena -> fallback'
    );
    assert.equal(
        script.safeProfileUrl('http://cw.x2.international.travian.com/x', ctx),
        FALLBACK_HREF,
        'http (inny origin) -> fallback'
    );
    assert.equal(
        script.safeProfileUrl('https://', ctx),
        FALLBACK_HREF,
        'nieparsowalny -> fallback'
    );
    assert.equal(script.safeProfileUrl(null, ctx), FALLBACK_HREF);
    // bez context i bez location -> '' (Node)
    assert.equal(script.safeProfileUrl('https://evil.example.com/x'), '');
    // przycięcie do EVENT_URL_MAX
    const longUrl = ORIGIN + '/profile/' + '9'.repeat(500);
    assert.equal(
        script.safeProfileUrl(longUrl, ctx).length,
        script.EVENT_URL_MAX
    );
});

test('buildEventDescriptionLine: compact delta-first format and safe names', () => {
    const ctx = { origin: ORIGIN, fallbackHref: FALLBACK_HREF };

    const line = script.buildEventDescriptionLine({
        name: 'Alice',
        url: 'https://cw.x2.international.travian.com/profile/385',
        attackCount: 3,
        raidCount: 1,
        addedAttackCount: 2,
        addedRaidCount: 1
    }, 1, ctx);

    assert.equal(line, 'Alice — +2 attacks · +1 raid (3 attacks / 1 raid active)');

    // długa nazwa: cap EVENT_NAME_MAX + escapowanie nawiasów
    const longName = 'A'.repeat(60) + ')(' + 'B'.repeat(20);
    const longLine = script.buildEventDescriptionLine({
        name: longName,
        url: 'https://cw.x2.international.travian.com/profile/385',
        attackCount: 1,
        raidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0
    }, 1, ctx);
    assert.ok(longLine.length < 1000, 'jedna linia nie przekracza budżetu');
    assert.ok(!longLine.includes(')('), 'nawiasy w nazwie escapowane');

    // Profile URLs are intentionally not repeated in compact player lines.
    const evil = script.buildEventDescriptionLine({
        name: 'Eve',
        url: 'https://evil.example.com/x',
        attackCount: 1,
        raidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0
    }, 2, ctx);
    assert.ok(!evil.includes('evil.example.com'), 'obca domena nie trafia do markdowna');

    // bez indeksu -> bez prefiksu numeru
    const noIndex = script.buildEventDescriptionLine({
        name: 'Bob',
        url: '/profile/1',
        attackCount: 0,
        raidCount: 0,
        addedAttackCount: 0,
        addedRaidCount: 0
    }, null, ctx);
    assert.equal(
        noIndex,
        'Bob — +0 attacks · +0 raids (0 attacks / 0 raids active)'
    );
});

test('chunkEventsForDiscord: FIFO, każdy event dokładnie raz, cap i budżet', () => {
    const events = [];
    for (let i = 1; i <= 25; i += 1) {
        events.push({
            name: 'P' + i,
            url: '/p/' + i,
            attackCount: 1,
            raidCount: 0,
            addedAttackCount: 1,
            addedRaidCount: 0
        });
    }
    const names = events.map(event => event.name);

    // domyślny budżet: przy krótkich liniach decyduje cap 20 -> 20 + 5
    const byCount = script.chunkEventsForDiscord(events);
    assert.equal(byCount.length, 2);
    assert.equal(byCount[0].length, 20);
    assert.equal(byCount[1].length, 5);
    assert.deepEqual(
        byCount.flat().map(event => event.name),
        names,
        'FIFO + każdy event dokładnie raz'
    );

    // własny cap liczby eventów
    const small = script.chunkEventsForDiscord(events, 3);
    assert.deepEqual(
        small.map(chunk => chunk.length),
        [3, 3, 3, 3, 3, 3, 3, 3, 1]
    );

    // budżet: estimator 100/event, limit 380 -> 3 eventy na chunk
    const budget = script.chunkEventsForDiscord(events, 20, 380, () => 100);
    assert.deepEqual(
        budget.map(chunk => chunk.length),
        [3, 3, 3, 3, 3, 3, 3, 3, 1]
    );
    assert.deepEqual(
        budget.flat().map(event => event.name),
        names,
        'budżet nie gubi ani nie duplikuje eventów'
    );

    // pojedynczy event większy niż budżet -> WŁASNY chunk (bez pomijania)
    const huge = script.chunkEventsForDiscord(
        [{ name: 'A' }, { name: 'B' }],
        20,
        100,
        () => 150
    );
    assert.deepEqual(
        huge.map(chunk => chunk.length),
        [1, 1],
        'oversized event dostaje własny chunk'
    );

    // brzegi
    assert.deepEqual(script.chunkEventsForDiscord([], 20), []);
    assert.deepEqual(script.chunkEventsForDiscord(null, 20), []);
    assert.deepEqual(script.chunkEventsForDiscord('x', 20), []);
});

test('selectMentions: rola pierwsza, dedup, limit 2000, spójność whitelist', () => {
    const many = [];
    for (let i = 0; i < 120; i += 1) {
        many.push(String(10000000000000000000 + i)); // 20 cyfr
    }

    const selected = script.selectMentions(
        ROLE,
        many.concat([many[0], many[1]])
    );

    assert.equal(selected.roleId, ROLE, 'rola zachowana');
    assert.equal(
        selected.userIds.length,
        new Set(selected.userIds).size,
        'deduplikacja'
    );
    assert.equal(selected.userIds[0], many[0], 'stabilna kolejność');
    assert.ok(selected.userIds.length < 120, 'część pominięta po limicie');

    const content = script.buildMentionContent(
        selected.roleId,
        selected.userIds
    );
    const allowed = script.buildAllowedMentions(
        selected.roleId,
        selected.userIds
    );

    assert.ok(
        content.length <= script.DISCORD_CONTENT_LIMIT,
        'content <= 2000'
    );

    // content i whitelista opisują DOKŁADNIE tę samą listę
    const contentIds = content
        .split(' ')
        .filter(token => token.startsWith('<@') && !token.startsWith('<@&'))
        .map(token => token.slice(2, -1));
    assert.deepEqual(contentIds, selected.userIds, 'content == wybrana lista');
    assert.deepEqual(allowed.users, selected.userIds, 'allowed_mentions == wybrana lista');
    assert.deepEqual(allowed.roles, [ROLE], 'rola w whiteliscie');
    assert.equal('parse' in allowed, false, 'bez klucza parse');

    // puste wybory
    assert.deepEqual(script.selectMentions(null, []), {
        roleId: null,
        userIds: []
    });
    assert.equal(script.buildMentionContent(null, []), '');

    // niepoprawna rola -> pominięta w content ORAZ w whiteliscie
    const badRole = script.selectMentions('abc', [UID_A]);
    assert.equal(badRole.roleId, null);
    assert.equal(
        script.buildMentionContent(badRole.roleId, badRole.userIds),
        `<@${UID_A}>`
    );
    assert.equal(
        'roles' in script.buildAllowedMentions(badRole.roleId, badRole.userIds),
        false
    );
});

test('selectMentions: niepoprawne user ID pomijane, dedup po walidacji', () => {
    const selected = script.selectMentions(ROLE, [
        UID_A,
        '<@' + UID_B + '>',     // wrapper wzmianki -> odrzucony
        '123',                  // za krótki -> odrzucony
        '   ' + UID_A + '  ',   // trim -> duplikat UID_A
        'garbage',              // nie-numeryczny -> odrzucony
        '',
        null,
        123456789012345678,     // nie-string (liczba) -> odrzucony
        UID_B
    ]);

    assert.deepEqual(selected, {
        roleId: ROLE,
        userIds: [UID_A, UID_B]
    }, 'tylko poprawne ID, stabilna kolejność, dedup po trim');

    // sam zepsuty input -> pusta lista, bez rzucania
    assert.deepEqual(
        script.selectMentions(null, ['nope', '<@123>', 'x', null]),
        { roleId: null, userIds: [] }
    );
    assert.deepEqual(
        script.selectMentions('abc', ['nope']),
        { roleId: null, userIds: [] }
    );
});

test('buildMentionContent/buildAllowedMentions: bezpośrednie wywołanie <= 2000 i spójne', () => {
    const many = [];
    for (let i = 0; i < 200; i += 1) {
        many.push(String(10000000000000000000 + i));
    }

    // content nie może przekroczyć 2000 nawet przy bezpośrednim wywołaniu
    const content = script.buildMentionContent(ROLE, many);
    assert.ok(
        content.length <= script.DISCORD_CONTENT_LIMIT,
        'content <= 2000 przy >2000 wejściowych znakach'
    );

    const allowed = script.buildAllowedMentions(ROLE, many);
    assert.ok(allowed.users.length < many.length, 'whitelista obcięta');
    assert.ok(allowed.users.length >= 1, 'część odbiorców zachowana');
    assert.deepEqual(allowed.roles, [ROLE]);

    // content i whitelista opisują DOKŁADNIE tę samą listę
    const ids = content
        .split(' ')
        .filter(token => token.startsWith('<@') && !token.startsWith('<@&'))
        .map(token => token.slice(2, -1));
    assert.deepEqual(ids, allowed.users, 'content == allowed_mentions.users');

    // niepoprawne ID filtrowane również przy bezpośrednim wywołaniu
    assert.equal(
        script.buildMentionContent(null, [UID_A, 'nope', UID_B, '']),
        `<@${UID_A}> <@${UID_B}>`
    );
    assert.equal(
        script.buildMentionContent(null, [UID_A, '<@' + UID_B + '>']),
        `<@${UID_A}>`,
        'wrapper wzmianki odrzucony także w builderze'
    );
    assert.deepEqual(
        script.buildAllowedMentions(null, [UID_A, 'nope', UID_A]),
        { users: [UID_A] }
    );
    assert.equal('parse' in script.buildAllowedMentions(ROLE, []), false);
    assert.equal('roles' in script.buildAllowedMentions(null, [UID_A]), false);
});

test('safeProfileUrl: obcy fallbackHref z contextu nigdy nie jest zwracany', () => {
    const evilFallback = {
        origin: ORIGIN,
        fallbackHref: 'https://evil.example.com/steal'
    };

    assert.equal(
        script.safeProfileUrl('https://evil.example.com/x', evilFallback),
        '',
        'obcy fallback -> brak fallbacku (nie obca domena)'
    );
    assert.equal(
        script.safeProfileUrl('', evilFallback),
        '',
        'pusty URL + obcy fallback -> \'\''
    );
    assert.equal(
        script.safeProfileUrl('/profile/1', evilFallback),
        'https://cw.x2.international.travian.com/profile/1',
        'poprawny URL nie używa fallbacku'
    );

    // poprawny (same-origin) fallback działa jak dotychczas
    const good = { origin: ORIGIN, fallbackHref: FALLBACK_HREF };
    assert.equal(
        script.safeProfileUrl('https://evil.example.com/x', good),
        FALLBACK_HREF
    );

    // względny fallback rozwiązywany względem originu
    const relative = { origin: ORIGIN, fallbackHref: '/alliance/members' };
    assert.equal(
        script.safeProfileUrl('https://evil.example.com/x', relative),
        'https://cw.x2.international.travian.com/alliance/members'
    );

    // nieparsowalny fallback -> ''
    const unparseable = { origin: ORIGIN, fallbackHref: 'https://' };
    assert.equal(
        script.safeProfileUrl('https://evil.example.com/x', unparseable),
        ''
    );

    // obcy fallback nie wycieka też przez markdown builders
    const line = script.buildEventDescriptionLine(
        { name: 'Eve', url: 'https://evil.example.com/x', attackCount: 1, raidCount: 0, addedAttackCount: 1, addedRaidCount: 0 },
        1,
        evilFallback
    );
    assert.ok(!line.includes('evil.example.com'), 'obca domena nie trafia do opisu');
});

// ---------------------------------------------------------------------------
// Multi-tab lease lidera (ochrona przed duplikacją przy wielu kartach)
// ---------------------------------------------------------------------------

const OWNER_A = 'tab-owner-a';
const OWNER_B = 'tab-owner-b';

test('tab lease: stałe i eksporty', () => {
    assert.equal(script.TAB_LEASE_TTL_MS, 120000);
    assert.equal(script.TAB_LEASE_RENEW_MS, 30000);
    assert.equal(script.TAB_LEASE_STORAGE_KEY, 'travianAllianceTabLease_v1');
    assert.notEqual(
        script.TAB_LEASE_STORAGE_KEY,
        script.PENDING_BATCH_STORAGE_KEY
    );

    for (const name of [
        'TAB_LEASE_STORAGE_KEY',
        'TAB_LEASE_TTL_MS',
        'TAB_LEASE_RENEW_MS',
        'parseLease',
        'classifyLease',
        'isLeaseActive',
        'createTabOwnerId',
        'loadLease',
        'saveLease',
        'acquireLease',
        'renewLease',
        'releaseLease'
    ]) {
        assert.ok(name in script, 'brak eksportu ' + name);
    }
});

test('parseLease: walidacja kształtu i złych dat', () => {
    assert.deepEqual(
        script.parseLease({ ownerId: 'tab-x', expiresAtMs: 1000 }),
        { ownerId: 'tab-x', expiresAtMs: 1000 }
    );
    assert.equal(script.parseLease(null), null);
    assert.equal(script.parseLease(undefined), null);
    assert.equal(script.parseLease('x'), null);
    assert.equal(script.parseLease([1, 2]), null, 'tablica odrzucona');
    assert.equal(script.parseLease({}), null, 'brak pól');
    assert.equal(
        script.parseLease({ ownerId: '   ', expiresAtMs: 1000 }),
        null,
        'pusty owner po trim'
    );
    assert.equal(
        script.parseLease({ ownerId: 42, expiresAtMs: 1000 }),
        null,
        'nie-string owner'
    );
    assert.equal(
        script.parseLease({ ownerId: 'x', expiresAtMs: '1000' }),
        null,
        'nie-liczba expires'
    );
    assert.equal(
        script.parseLease({ ownerId: 'x', expiresAtMs: NaN }),
        null
    );
    assert.equal(
        script.parseLease({ ownerId: 'x', expiresAtMs: Infinity }),
        null
    );
});

test('classifyLease / isLeaseActive: brak, własny, obcy, wygasły, złe daty', () => {
    const now = 1_000_000;

    assert.equal(script.classifyLease(null, OWNER_A, now), 'none');
    assert.equal(script.classifyLease('junk', OWNER_A, now), 'none');
    assert.equal(
        script.classifyLease(
            { ownerId: OWNER_A, expiresAtMs: now + 1000 },
            OWNER_A,
            now
        ),
        'own'
    );
    assert.equal(
        script.classifyLease(
            { ownerId: OWNER_B, expiresAtMs: now + 1000 },
            OWNER_A,
            now
        ),
        'foreign',
        'obcy niewygasły blokuje'
    );
    assert.equal(
        script.classifyLease(
            { ownerId: OWNER_B, expiresAtMs: now - 1 },
            OWNER_A,
            now
        ),
        'expired',
        'obcy wygasły -> można przejąć'
    );
    assert.equal(
        script.classifyLease(
            { ownerId: OWNER_A, expiresAtMs: now - 1 },
            OWNER_A,
            now
        ),
        'expired',
        'własny wygasły -> można odnowić/przejąć'
    );
    assert.equal(
        script.classifyLease(
            { ownerId: OWNER_B, expiresAtMs: now },
            OWNER_A,
            now
        ),
        'expired',
        'expiresAtMs == now -> wygasły (granica)'
    );

    // isLeaseActive: true tylko dla 'own'
    assert.equal(
        script.isLeaseActive(
            { ownerId: OWNER_A, expiresAtMs: now + 1000 },
            OWNER_A,
            now
        ),
        true
    );
    assert.equal(
        script.isLeaseActive(
            { ownerId: OWNER_B, expiresAtMs: now + 1000 },
            OWNER_A,
            now
        ),
        false
    );
    assert.equal(script.isLeaseActive(null, OWNER_A, now), false);
});

test('createTabOwnerId: stabilny identyfikator bez sekretów', () => {
    const a = script.createTabOwnerId();
    const b = script.createTabOwnerId();

    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    assert.notEqual(a, b, 'kolejne wywołania różne');
    assert.ok(!a.includes('discord'), 'bez sekretów');
});

test('loadLease/saveLease: roundtrip, uszkodzony storage, merge per świat', () => {
    // bez localStorage -> null/false
    assert.equal(script.loadLease(HOST), null);
    assert.equal(script.saveLease(HOST, { ownerId: OWNER_A, expiresAtMs: 1 }), false);

    withLocalStorage({}, map => {
        assert.equal(script.loadLease(HOST), null, 'brak -> null');

        map[script.TAB_LEASE_STORAGE_KEY] = 'not-json{';
        assert.equal(script.loadLease(HOST), null, 'uszkodzony JSON -> null');

        map[script.TAB_LEASE_STORAGE_KEY] = '[1,2]';
        assert.equal(script.loadLease(HOST), null, 'tablica -> null');

        map[script.TAB_LEASE_STORAGE_KEY] = JSON.stringify({
            [HOST]: 'garbage'
        });
        assert.equal(script.loadLease(HOST), null, 'zły wpis świata -> null');

        assert.equal(
            script.saveLease(HOST, { ownerId: OWNER_A, expiresAtMs: 123 }),
            true
        );
        assert.deepEqual(script.loadLease(HOST), {
            ownerId: OWNER_A,
            expiresAtMs: 123
        });

        // merge: inne światy nietknięte
        script.saveLease('other.world', { ownerId: OWNER_B, expiresAtMs: 456 });
        assert.deepEqual(script.loadLease(HOST), {
            ownerId: OWNER_A,
            expiresAtMs: 123
        });
        assert.deepEqual(script.loadLease('other.world'), {
            ownerId: OWNER_B,
            expiresAtMs: 456
        });
    });
});

test('acquireLease: brak/własny/wygasły -> zdobyty; obcy aktywny -> zablokowany', () => {
    const now = 2_000_000;

    // brak localStorage -> null (best-effort)
    assert.equal(script.acquireLease(HOST, OWNER_A, now), null);

    withLocalStorage({}, map => {
        // brak lease -> zdobyty (read-back weryfikuje)
        assert.equal(script.acquireLease(HOST, OWNER_A, now), true);
        assert.deepEqual(script.loadLease(HOST), {
            ownerId: OWNER_A,
            expiresAtMs: now + script.TAB_LEASE_TTL_MS
        });

        // własny aktywny -> ponowne zdobycie OK (przedłuża expiresAtMs)
        assert.equal(script.acquireLease(HOST, OWNER_A, now + 1000), true);

        // obcy niewygasły -> BLOKADA startu
        assert.equal(script.acquireLease(HOST, OWNER_B, now + 1000), false);
        assert.deepEqual(
            script.loadLease(HOST),
            {
                ownerId: OWNER_A,
                expiresAtMs: (now + 1000) + script.TAB_LEASE_TTL_MS
            },
            'obcy lease nie nadpisany'
        );

        // wygasły obcy -> przejęcie (lease A wygasa w now+1000+TTL)
        assert.equal(
            script.acquireLease(
                HOST,
                OWNER_B,
                now + 1000 + script.TAB_LEASE_TTL_MS + 1
            ),
            true
        );
        assert.equal(script.loadLease(HOST).ownerId, OWNER_B);

        // rzucający setItem -> null (koordynacja niedostępna, best-effort)
        global.localStorage = {
            getItem: () => null,
            setItem: () => {
                throw new Error('quota');
            }
        };
        assert.equal(script.acquireLease(HOST, OWNER_A, now), null);
    });
});

test('renewLease: przedłuża tylko własny aktywny; nie nadpisuje obcego', () => {
    const now = 3_000_000;

    // bez localStorage -> false
    assert.equal(script.renewLease(HOST, OWNER_A, now), false);

    withLocalStorage({}, map => {
        script.saveLease(HOST, { ownerId: OWNER_A, expiresAtMs: now + 1000 });

        // własny aktywny -> odnowienie przedłuża expiresAtMs
        assert.equal(script.renewLease(HOST, OWNER_A, now), true);
        assert.deepEqual(script.loadLease(HOST), {
            ownerId: OWNER_A,
            expiresAtMs: now + script.TAB_LEASE_TTL_MS
        });

        // obcy aktywny -> false, bez nadpisania
        script.saveLease(HOST, { ownerId: OWNER_B, expiresAtMs: now + 1000 });
        assert.equal(script.renewLease(HOST, OWNER_A, now), false);
        assert.equal(script.loadLease(HOST).ownerId, OWNER_B, 'obcy lease nietknięty');

        // własny wygasły -> false (nie odnawia, wymaga przejęcia)
        script.saveLease(HOST, { ownerId: OWNER_A, expiresAtMs: now - 1 });
        assert.equal(script.renewLease(HOST, OWNER_A, now), false);

        // brak lease -> false
        script.saveLease(HOST, { ownerId: OWNER_A, expiresAtMs: now + 1 });
        script.releaseLease(HOST, OWNER_A, now);
        assert.equal(script.renewLease(HOST, OWNER_A, now), false);
    });
});

test('releaseLease: usuwa tylko własny wpis; obcy zostaje', () => {
    const now = 4_000_000;

    // bez localStorage -> false
    assert.equal(script.releaseLease(HOST, OWNER_A, now), false);

    withLocalStorage({}, map => {
        script.saveLease(HOST, { ownerId: OWNER_A, expiresAtMs: now + 1000 });

        // obcy nie usuwa cudzego lease
        assert.equal(script.releaseLease(HOST, OWNER_B, now), false);
        assert.equal(script.loadLease(HOST).ownerId, OWNER_A);

        // własny -> usunięty
        assert.equal(script.releaseLease(HOST, OWNER_A, now), true);
        assert.equal(script.loadLease(HOST), null);

        // ponowne zwolnienie -> false
        assert.equal(script.releaseLease(HOST, OWNER_A, now), false);
    });
});

test('tab lease: scenariusz dwóch kart (przejęcie po TTL)', () => {
    const now = 5_000_000;

    withLocalStorage({}, () => {
        // karta A zdobywa lease
        assert.equal(script.acquireLease(HOST, OWNER_A, now), true);

        // karta B startuje przy żywym lease A -> zablokowana
        assert.equal(script.acquireLease(HOST, OWNER_B, now + 10), false);

        // karta A pada (brak odnowienia); po TTL lease wygasa
        assert.equal(
            script.acquireLease(
                HOST,
                OWNER_B,
                now + script.TAB_LEASE_TTL_MS + 10
            ),
            true,
            'karta B przejmuje po wygaśnięciu TTL'
        );
        assert.equal(script.loadLease(HOST).ownerId, OWNER_B);

        // karta A wraca -> blokowana przez żywy lease B
        assert.equal(
            script.acquireLease(
                HOST,
                OWNER_A,
                now + script.TAB_LEASE_TTL_MS + 20
            ),
            false
        );

        // B zwalnia przy zamykaniu -> A może przejąć
        assert.equal(
            script.releaseLease(
                HOST,
                OWNER_B,
                now + script.TAB_LEASE_TTL_MS + 30
            ),
            true
        );
        assert.equal(
            script.acquireLease(
                HOST,
                OWNER_A,
                now + script.TAB_LEASE_TTL_MS + 40
            ),
            true
        );
    });
});

// ---------------------------------------------------------------------------
// Gotowość DOM (isAlliancePageReady — pusty baseline bez heurystyki wierszy)
// ---------------------------------------------------------------------------

test('isAlliancePageReady: complete + komplet elementów -> true', () => {
    assert.ok('isAlliancePageReady' in script, 'eksport helpera');
    assert.equal(script.isAlliancePageReady('complete', true, true), true);
});

test('isAlliancePageReady: loading/interactive -> false', () => {
    assert.equal(script.isAlliancePageReady('loading', true, true), false);
    assert.equal(script.isAlliancePageReady('interactive', true, true), false);
    assert.equal(script.isAlliancePageReady('uninitialized', true, true), false);
});

test('isAlliancePageReady: brak tabeli lub brak wiersza gracza -> false', () => {
    assert.equal(script.isAlliancePageReady('complete', false, true), false, 'brak tabeli');
    assert.equal(script.isAlliancePageReady('complete', true, false), false, 'brak wiersza gracza');
    assert.equal(script.isAlliancePageReady('complete', false, false), false, 'brak obu');
});

test('isAlliancePageReady: wielkość nie ma znaczenia (1/19/20 — bez magicznej liczby)', () => {
    // Stara heurystyka 'rows >= 20' zniknęła: helper nie przyjmuje
    // liczby wierszy, więc jeden wiersz gracza przy kompletnym
    // dokumencie i tabeli daje true — niezależnie od "rozmiaru".
    assert.equal(script.isAlliancePageReady('complete', true, true), true);
    assert.equal(script.isAlliancePageReady('complete', true, false), false);
});

test('isAlliancePageReady: złe typy -> false', () => {
    assert.equal(script.isAlliancePageReady(null, true, true), false);
    assert.equal(script.isAlliancePageReady(undefined, true, true), false);
    assert.equal(script.isAlliancePageReady('', true, true), false);
    assert.equal(script.isAlliancePageReady(5, true, true), false);
    assert.equal(script.isAlliancePageReady('COMPLETE', true, true), false, 'case-sensitive');
    assert.equal(script.isAlliancePageReady('complete', 1, true), false);
    assert.equal(script.isAlliancePageReady('complete', 'true', true), false);
    assert.equal(script.isAlliancePageReady('complete', null, true), false);
    assert.equal(script.isAlliancePageReady('complete', undefined, true), false);
    assert.equal(script.isAlliancePageReady('complete', true, 1), false);
    assert.equal(script.isAlliancePageReady('complete', true, 'true'), false);
    assert.equal(script.isAlliancePageReady('complete', true, null), false);
    assert.equal(script.isAlliancePageReady('complete', true, undefined), false);
});

// ---------------------------------------------------------------------------
// Todo 4 lifecycle seams: readiness, fencing, jitter, document scan state
// ---------------------------------------------------------------------------

test('readiness decision: complete table and quiet window are required', () => {
    assert.equal(script.isReadinessReady('complete', true, 500), true);
    assert.equal(script.isReadinessReady('complete', true, 499), false);
    assert.equal(script.isReadinessReady('interactive', true, 500), false);
    assert.equal(script.isReadinessReady('complete', false, 500), false);
    assert.equal(script.isReadinessReady('complete', true, Infinity), false);
});

test('readiness quiet-window boundary: exactly 500ms is ready without a real timer', () => {
    const observations = [499, 500, 501].map(quietMs => ({
        quietMs,
        ready: script.isReadinessReady('complete', true, quietMs)
    }));

    assert.deepEqual(observations, [
        { quietMs: 499, ready: false },
        { quietMs: 500, ready: true },
        { quietMs: 501, ready: true }
    ]);
});

test('scan-cycle readiness deadline is inclusive and quiet time remains mandatory', () => {
    assert.equal(script.SCAN_CYCLE_DEADLINE_MS, 15000);
    assert.equal(script.SCAN_CYCLE_QUIET_MS, 500);
    assert.equal(script.isScanCycleReady('complete', true, 499), false);
    assert.equal(script.isScanCycleReady('complete', true, 500), true);
    assert.equal(script.decideScanCycleOutcome({
        elapsedMs: 14999, quietMs: 0, leaseHeld: true, parserResult: null, commitResult: null
    }), null);
    assert.deepEqual(script.decideScanCycleOutcome({
        elapsedMs: 15000, quietMs: 0, leaseHeld: true, parserResult: null, commitResult: null
    }), { terminal: true, stage: 'snapshot', status: 'rejected', reason: 'readiness-timeout' });
});

test('scan-cycle state machine maps lease, parser, commit, and accepted terminals', () => {
    const cases = [
        [{ elapsedMs: 0, quietMs: 500, leaseHeld: false, parserResult: null, commitResult: null },
            { terminal: true, stage: 'lease', status: 'rejected', reason: 'lease-lost-before-scan' }],
        [{ elapsedMs: 0, quietMs: 500, leaseHeld: true, parserResult: { status: 'rejected', reason: 'malformed-count' }, commitResult: null },
            { terminal: true, stage: 'snapshot', status: 'rejected', reason: 'malformed-count' }],
        [{ elapsedMs: 0, quietMs: 500, leaseHeld: true, parserResult: { status: 'accepted' }, commitResult: { status: 'blocked' } },
            { terminal: true, stage: 'snapshot', status: 'error', reason: 'monitor-commit-blocked' }],
        [{ elapsedMs: 0, quietMs: 500, leaseHeld: true, parserResult: { status: 'accepted' }, commitResult: { status: 'ok' } },
            { terminal: true, stage: 'snapshot', status: 'ok', reason: 'authoritative' }]
    ];
    for (const [input, expected] of cases) assert.deepEqual(script.decideScanCycleOutcome(input), expected);
});

test('scan-cycle preserves every parser rejection reason and maps commit fences', () => {
    for (const reason of script.MEMBER_TABLE_REASON_CODES) {
        assert.equal(script.decideScanCycleOutcome({
            elapsedMs: 0, quietMs: 500, leaseHeld: true,
            parserResult: { status: 'rejected', reason }, commitResult: null
        }).reason, reason);
    }
    for (const reason of ['monitor-blocked', 'fence-before-monitor-commit', 'monitor-commit-blocked', 'scan-error']) {
        assert.equal(script.decideScanCycleOutcome({
            elapsedMs: 0, quietMs: 500, leaseHeld: true,
            parserResult: { status: 'accepted' }, commitResult: { status: 'error', reason }
        }).reason, reason);
    }
});

test('scan-cycle IDs are bounded opaque diagnostics and reload refusals cannot replace scan results', () => {
    const scanId = script.createScanCycleId('test-cycle-seed');
    assert.match(scanId, /^sc1:[0-9a-f]{8}$/);
    assert.ok(scanId.length <= 32);
    const world = script.appendDiagnosticTraceV2(script.createDiagnosticsWorldV2('world.example'), {
        stage: 'snapshot', status: 'ok', reason: 'authoritative', scanId
    });
    const trace = world.records.at(-1);
    assert.notEqual(trace.scanId, scanId);
    assert.match(trace.scanId, /^[0-9a-f]{8}$/);
    assert.deepEqual(script.classifyReloadRefusal('reload-unavailable', scanId), {
        stage: 'reload', status: 'rejected', reason: 'reload-unavailable', scanId
    });
    assert.deepEqual(script.selectScanTerminalRecord([
        { sequence: 1, stage: 'snapshot', status: 'rejected', reason: 'malformed-count', scanId },
        { sequence: 2, stage: 'route', status: 'ok', scanId },
        { sequence: 3, stage: 'reload', status: 'rejected', reason: 'reload-unavailable', scanId }
    ]), { sequence: 1, stage: 'snapshot', status: 'rejected', reason: 'malformed-count', scanId });
});

test('generic lifecycle hooks can never become scan terminals', () => {
    assert.equal(script.isScanTerminalRecord({ stage: 'route', status: 'ok', reason: 'authoritative' }), false);
    assert.equal(script.isScanTerminalRecord({ stage: 'snapshot', status: 'ok', reason: 'authoritative' }), true);
    assert.equal(script.selectScanTerminalRecord([
        { sequence: 1, stage: 'route', status: 'ok' },
        { sequence: 2, stage: 'route', status: 'ok', reason: 'authoritative' }
    ]), null);
});

test('lifecycle fence: only the active owner token may continue', () => {
    assert.equal(script.isLifecycleFenceValid(true, 'token-a', 'token-a'), true);
    assert.equal(script.isLifecycleFenceValid(true, 'token-a', 'token-b'), false);
    assert.equal(script.isLifecycleFenceValid(false, 'token-a', 'token-a'), false);
    assert.equal(script.isLifecycleFenceValid(true, '', 'token-a'), false);
    assert.deepEqual(
        script.checkLifecycleFence(true, 'token-a', 'token-b'),
        { outcome: 'fenced-reject' }
    );
});

function runDeterministicScanCycle({ leaseHeld = true, mutations = [] } = {}) {
    let now = 0;
    let extractionCalls = 0;
    let reloadCalls = 0;
    const terminals = [];
    let quietTimer = null;
    let deadlineTimer = script.SCAN_CYCLE_DEADLINE_MS;
    let lastMutationAt = -script.SCAN_CYCLE_QUIET_MS;
    const terminal = outcome => {
        if (terminals.length > 0 || !outcome) return;
        terminals.push(outcome);
        quietTimer = null;
        deadlineTimer = null;
    };
    const check = () => {
        const outcome = script.decideScanCycleOutcome({
            elapsedMs: now,
            quietMs: now - lastMutationAt,
            leaseHeld,
            parserResult: null,
            commitResult: null
        });
        if (outcome) terminal(outcome);
        else quietTimer = lastMutationAt + script.SCAN_CYCLE_QUIET_MS;
    };
    check();
    for (const mutationAt of mutations) {
        if (terminals.length > 0) break;
        now = mutationAt;
        lastMutationAt = now;
        quietTimer = now + script.SCAN_CYCLE_QUIET_MS;
        if (deadlineTimer !== null && now >= deadlineTimer) {
            terminal(script.decideScanCycleOutcome({ elapsedMs: deadlineTimer, quietMs: now - lastMutationAt, leaseHeld, parserResult: null }));
            break;
        }
    }
    if (terminals.length === 0) {
        if (quietTimer !== null && (deadlineTimer === null || quietTimer <= deadlineTimer)) {
            now = quietTimer;
            const ready = script.isScanCycleReady('complete', true, now - lastMutationAt);
            if (ready) {
                extractionCalls += 1;
                terminal(script.decideScanCycleOutcome({ elapsedMs: now, quietMs: now - lastMutationAt, leaseHeld, parserResult: { status: 'accepted' }, commitResult: { status: 'ok' } }));
            }
        } else if (deadlineTimer !== null && deadlineTimer <= 15000) {
            now = deadlineTimer;
            terminal(script.decideScanCycleOutcome({ elapsedMs: now, quietMs: now - lastMutationAt, leaseHeld, parserResult: null }));
        }
    }
    if (terminals.length > 0 && terminals[0].stage === 'lease') reloadCalls = 0;
    return { extractionCalls, reloadCalls, terminals };
}

test('bounded scan fake clock waits for quiet and times out without extraction', () => {
    const cycle = runDeterministicScanCycle({ mutations: Array.from({ length: 37 }, (_, index) => (index + 1) * 400) });
    assert.equal(cycle.extractionCalls, 0);
    assert.deepEqual(cycle.terminals, [{ terminal: true, stage: 'snapshot', status: 'rejected', reason: 'readiness-timeout' }]);
    assert.equal(cycle.terminals.length, 1);
});

test('bounded scan fake clock accepts exactly once after 500ms quiet', () => {
    const cycle = runDeterministicScanCycle({ mutations: [100] });
    assert.equal(cycle.extractionCalls, 1);
    assert.equal(cycle.terminals.length, 1);
    assert.deepEqual(cycle.terminals[0], { terminal: true, stage: 'snapshot', status: 'ok', reason: 'authoritative' });
});

test('lease loss before scan is terminal and cannot reload', () => {
    const cycle = runDeterministicScanCycle({ leaseHeld: false });
    assert.equal(cycle.extractionCalls, 0);
    assert.equal(cycle.reloadCalls, 0);
    assert.deepEqual(cycle.terminals, [{ terminal: true, stage: 'lease', status: 'rejected', reason: 'lease-lost-before-scan' }]);
});

test('startup acquisition jitter: deterministic value stays within bounds', () => {
    assert.equal(script.getStartupAcquisitionJitterMs(0), script.STARTUP_ACQUIRE_JITTER_MIN_MS);
    assert.equal(script.getStartupAcquisitionJitterMs(1), script.STARTUP_ACQUIRE_JITTER_MAX_MS);
    assert.equal(
        script.getStartupAcquisitionJitterMs(0.5),
        Math.floor((script.STARTUP_ACQUIRE_JITTER_MIN_MS + script.STARTUP_ACQUIRE_JITTER_MAX_MS) / 2)
    );
    assert.equal(script.getStartupAcquisitionJitterMs(-1), script.STARTUP_ACQUIRE_JITTER_MIN_MS);
});

test('document scan state: acquisition resumes without a second scan', () => {
    let state = script.createDocumentScanState();
    assert.equal(script.shouldAttemptDocumentScan(state), true);
    state = script.markDocumentScanAttempted(state);
    assert.equal(script.shouldAttemptDocumentScan(state), false);
    assert.equal(script.markDocumentScanAttempted(state), state);
    assert.deepEqual(script.resetDocumentScanState(), { scanAttemptedForDocument: false });
});

test('attack-only lifecycle leaves legacy news storage untouched', async () => {
    // Given: legacy values are seeded before the runtime spy is installed.
    const values = new Map([
        ['taa:news:v1:legacy:active', '{"sentinel":"active"}'],
        ['taa:news:webhook:v1:legacy', 'https://discord.invalid/legacy']
    ]);
    const before = new Map(values);
    const calls = [];
    const storage = {
        get(key) { calls.push(['get', key]); return values.get(key); },
        set(key, value) { calls.push(['set', key]); values.set(key, String(value)); },
        delete(key) { calls.push(['delete', key]); values.delete(key); }
    };
    const instrumentedStorage = script.monitorStorageAdapter(storage);

    // When: the standalone lifecycle runs, with a panel-equivalent no-op hook.
    const result = await script.runAttackLifecycleForDocument({
        scan: async () => ({ status: 'partial' }),
        commit: async () => { throw new Error('partial snapshot committed'); },
        flush: async () => {},
        reload: async () => {},
        lease: async () => {},
        storage: instrumentedStorage,
        panel: () => {}
    });

    // Then: no runtime operation touches legacy news keys or values.
    assert.deepEqual(result.events, ['scan', 'flush', 'reload', 'lease']);
    assert.deepEqual(calls, []);
    assert.deepEqual(values, before);
});

test('attack lifecycle flushes and reloads after scan failure', async () => {
    const events = [];
    const result = await script.runAttackLifecycleForDocument({
        scan: async () => { events.push('scan'); throw new Error('scan failed'); },
        commit: async () => events.push('commit'),
        flush: async () => events.push('flush'),
        reload: async () => events.push('reload'),
        lease: async () => events.push('lease')
    });
    assert.equal(result.outcome, 'scan-failed');
    assert.deepEqual(events, ['scan', 'flush', 'reload', 'lease']);
    assert.deepEqual(result.events, ['flush', 'reload', 'lease']);
});

// ---------------------------------------------------------------------------
// Niezmapowani członkowie (computeUnmappedPlayers)
// ---------------------------------------------------------------------------

test('computeUnmappedPlayers: mixed — tylko niezmapowani w wyniku', () => {
    const members = [
        { id: '111', name: 'Alpha' },
        { id: '222', name: 'Beta' },
        { id: '333', name: 'Gamma' }
    ];
    const mappings = {
        [HOST]: {
            '111': ['111111111111111111'],
            '333': [] // pusta lista odbiorców -> to NIE jest mapowanie
        }
    };

    const result = script.computeUnmappedPlayers(
        members,
        mappings,
        {},
        HOST
    );

    assert.deepEqual(
        result.map(m => m.id),
        ['222', '333']
    );
});

test('computeUnmappedPlayers: wyciszeni nigdy w wyniku', () => {
    const members = [
        { id: '111', name: 'Alpha' },
        { id: '222', name: 'Beta' },
        { id: '333', name: 'Gamma' }
    ];
    const muted = {
        [HOST]: {
            '222': true,
            '333': true
        }
    };

    const result = script.computeUnmappedPlayers(
        members,
        {},
        muted,
        HOST
    );

    assert.deepEqual(
        result.map(m => m.id),
        ['111']
    );
});

test('computeUnmappedPlayers: sort pl — kolacja polska (ą po a, przed b)', () => {
    const members = [
        { id: '3', name: 'Bob' },
        { id: '1', name: 'Ala' },
        { id: '2', name: 'Ąga' }
    ];

    const result = script.computeUnmappedPlayers(
        members,
        {},
        {},
        HOST
    );

    assert.deepEqual(
        result.map(m => m.name),
        ['Ala', 'Ąga', 'Bob']
    );
});

test('computeUnmappedPlayers: złe typy -> [] bez rzucania; wpisy bez id pomijane', () => {
    assert.deepEqual(
        script.computeUnmappedPlayers(null, {}, {}, HOST),
        []
    );
    assert.deepEqual(
        script.computeUnmappedPlayers(undefined, {}, {}, HOST),
        []
    );
    assert.deepEqual(
        script.computeUnmappedPlayers('members', {}, {}, HOST),
        []
    );
    assert.deepEqual(
        script.computeUnmappedPlayers({}, {}, {}, HOST),
        []
    );
    assert.deepEqual(
        script.computeUnmappedPlayers([], {}, {}, HOST),
        []
    );

    const members = [
        null,
        'not-an-object',
        42,
        { name: 'NoId' },
        {},
        { id: '111', name: 'Alpha' }
    ];

    const result = script.computeUnmappedPlayers(
        members,
        {},
        {},
        HOST
    );

    assert.deepEqual(
        result.map(m => m.id),
        ['111']
    );
});

test('computeUnmappedPlayers: wszyscy zmapowani -> []', () => {
    const members = [
        { id: '111', name: 'Alpha' },
        { id: '222', name: 'Beta' }
    ];
    const mappings = {
        [HOST]: {
            '111': ['111111111111111111'],
            '222': ['222222222222222222']
        }
    };

    assert.deepEqual(
        script.computeUnmappedPlayers(members, mappings, {}, HOST),
        []
    );
});

test('computeUnmappedPlayers: nie mutuje wejść', () => {
    const members = [
        { id: '3', name: 'Bob' },
        { id: '1', name: 'Ala' },
        { id: '2', name: 'Ąga' }
    ];
    const mappings = {
        [HOST]: {
            '2': ['111111111111111111']
        }
    };
    const muted = {
        [HOST]: {
            '3': true
        }
    };

    const membersBefore = JSON.parse(JSON.stringify(members));
    const mappingsBefore = JSON.parse(JSON.stringify(mappings));
    const mutedBefore = JSON.parse(JSON.stringify(muted));

    script.computeUnmappedPlayers(members, mappings, muted, HOST);

    assert.deepEqual(members, membersBefore, 'members bez zmian');
    assert.deepEqual(mappings, mappingsBefore, 'mappings bez zmian');
    assert.deepEqual(muted, mutedBefore, 'muted bez zmian');
});

test('computeUnmappedPlayers: izolacja hostname — mapowania innego świata nie wykluczają', () => {
    const members = [
        { id: '111', name: 'Alpha' }
    ];
    const mappings = {
        'other.world.travian.com': {
            '111': ['111111111111111111']
        }
    };

    const result = script.computeUnmappedPlayers(
        members,
        mappings,
        {},
        HOST
    );

    assert.deepEqual(
        result.map(m => m.id),
        ['111']
    );
});

// ---------------------------------------------------------------------------
// Cache nazw graczy (player names)
// ---------------------------------------------------------------------------

const NAMES_KEY = script.PLAYER_NAMES_STORAGE_KEY;

test('player names: wersjonowany klucz storage, rozłączny od pozostałych', () => {
    assert.equal(NAMES_KEY, 'travianAlliancePlayerNames_v1');
    assert.notEqual(NAMES_KEY, script.SETTINGS_STORAGE_KEY);
    assert.notEqual(NAMES_KEY, script.HISTORY_STORAGE_KEY);
    assert.notEqual(NAMES_KEY, script.PENDING_BATCH_STORAGE_KEY);
    assert.notEqual(NAMES_KEY, script.FAILED_BATCH_STORAGE_KEY);
    assert.notEqual(NAMES_KEY, script.TAB_LEASE_STORAGE_KEY);
});

test('loadPlayerNames/savePlayerNames bez localStorage: bezpieczne no-opy', () => {
    assert.deepEqual(script.loadPlayerNames(), {});
    assert.equal(script.savePlayerNames({ a: 1 }), undefined);
});

test('loadPlayerNames: brak wpisu w storage -> {}', () => {
    withLocalStorage({}, (map) => {
        assert.deepEqual(script.loadPlayerNames(), {});
        assert.deepEqual(script.loadPlayerNames()[HOST], undefined);
    });
});

test('loadPlayerNames: uszkodzony JSON -> {}', () => {
    withLocalStorage({ [NAMES_KEY]: '{oops' }, () => {
        assert.deepEqual(script.loadPlayerNames(), {});
    });
});

test('loadPlayerNames: nieprawidłowy kształt (tablica/null) -> {}', () => {
    withLocalStorage({ [NAMES_KEY]: '["a"]' }, () => {
        assert.deepEqual(script.loadPlayerNames(), {});
    });
    withLocalStorage({ [NAMES_KEY]: 'null' }, () => {
        assert.deepEqual(script.loadPlayerNames(), {});
    });
});

test('savePlayerNames/loadPlayerNames: roundtrip przez localStorage', () => {
    withLocalStorage({}, (map) => {
        const names = { [HOST]: { '385': 'Sorryeu' } };

        script.savePlayerNames(names);

        assert.deepEqual(script.loadPlayerNames(), names);
        assert.equal(map[NAMES_KEY], JSON.stringify(names));
    });
});

test('addPlayerNamesBatch: dodanie bez mutacji, cleanText, nie-stringowe id pomijane', () => {
    const names = {};
    const next = script.addPlayerNamesBatch(names, HOST, [
        { id: 385, name: '  Sorryeu  ' }, // nie-string -> pominięty
        { id: null, name: 'NullBoy' },    // null -> pominięty (bez klucza 'null')
        { id: '999', name: 'Zulu' }
    ]);

    assert.deepEqual(next, {
        [HOST]: { '999': 'Zulu' }
    });
    assert.deepEqual(names, {});
});

test('addPlayerNamesBatch: puste id albo nazwa są pomijane', () => {
    const next = script.addPlayerNamesBatch({}, HOST, [
        { id: '', name: 'NoId' },
        { id: '222', name: '   ' },
        { id: '333', name: null },
        { id: '444', name: undefined },
        null,
        'not-an-entry',
        { id: '555', name: 'Delta' }
    ]);

    assert.deepEqual(next, { [HOST]: { '555': 'Delta' } });
});

test('addPlayerNamesBatch: hostname normalizowany do małych liter', () => {
    const next = script.addPlayerNamesBatch(
        {},
        'CW.X2.INTERNATIONAL.TRAVIAN.COM',
        [{ id: '385', name: 'Sorryeu' }]
    );

    assert.deepEqual(next, { [HOST]: { '385': 'Sorryeu' } });
});

test('addPlayerNamesBatch: brak zmian -> ta sama referencja', () => {
    const names = { [HOST]: { '385': 'Sorryeu' } };

    assert.equal(
        script.addPlayerNamesBatch(names, HOST, [
            { id: '385', name: 'Sorryeu' }
        ]),
        names
    );
    assert.equal(script.addPlayerNamesBatch(names, HOST, []), names);
    assert.equal(
        script.addPlayerNamesBatch(names, HOST, [
            { id: '111', name: '' }
        ]),
        names
    );
});

test('addPlayerNamesBatch: świeższa nazwa nadpisuje starą (rename)', () => {
    const names = { [HOST]: { '385': 'StaraNazwa' } };
    const next = script.addPlayerNamesBatch(names, HOST, [
        { id: '385', name: 'NowaNazwa' }
    ]);

    assert.notEqual(next, names);
    assert.deepEqual(next, { [HOST]: { '385': 'NowaNazwa' } });
    assert.deepEqual(names, { [HOST]: { '385': 'StaraNazwa' } });
});

test('buildIdToName: mapa id -> nazwa z cache', () => {
    const names = { [HOST]: { '385': 'Sorryeu', '999': 'Zulu' } };
    const idToName = script.buildIdToName(names, HOST);

    assert.ok(idToName instanceof Map);
    assert.equal(idToName.size, 2);
    assert.equal(idToName.get('385'), 'Sorryeu');
    assert.equal(idToName.get('999'), 'Zulu');
    assert.equal(idToName.has('111'), false);
});

test('buildIdToName: nieznany hostname albo brak cache -> pusty Map', () => {
    const names = { [HOST]: { '385': 'Sorryeu' } };

    assert.equal(script.buildIdToName(names, 'inny.swiat').size, 0);
    assert.equal(script.buildIdToName({}, HOST).size, 0);
    assert.equal(script.buildIdToName(undefined, HOST).size, 0);
    assert.equal(script.buildIdToName(null, HOST).size, 0);
});

test('collectUnknownIds: znane wykluczone, dedup, mapowania przed wyciszeniami', () => {
    const idToName = script.buildIdToName(
        { [HOST]: { '385': 'Sorryeu', '555': 'Delta' } },
        HOST
    );

    const unknown = script.collectUnknownIds(
        [
            '385 → 111111111111111111',
            '111 → 222222222222222222',
            '555 → 333333333333333333'
        ],
        ['999', '111'],
        idToName
    );

    // 385 i 555 znane w cache -> pominięte; 111 z mapowań; 999 z wyciszeń;
    // powtórka 111 (wyciszenia) zdeduplikowana (pierwsze wystąpienie wygrywa)
    assert.deepEqual(unknown, ['111', '999']);
});

test('collectUnknownIds: item bez " → " traktowany w całości', () => {
    assert.deepEqual(
        script.collectUnknownIds(['777'], [], new Map()),
        ['777']
    );
});

test('collectUnknownIds: nie-stringi i puste są pomijane', () => {
    const unknown = script.collectUnknownIds(
        ['111', 222, '', null, undefined, ' → '],
        ['', '333', 444],
        new Map()
    );

    assert.deepEqual(unknown, ['111', '333']);
});

test('collectUnknownIds: excludeIds (Set i tablica) wyklucza bez mutacji', () => {
    const idToName = new Map([['111', 'Known']]);

    assert.deepEqual(
        script.collectUnknownIds(
            ['111', '222', '333'],
            ['444'],
            idToName,
            new Set(['222', '444'])
        ),
        ['333']
    );
    assert.deepEqual(
        script.collectUnknownIds(
            ['111', '222', '333'],
            ['444'],
            idToName,
            ['222', '444']
        ),
        ['333']
    );
    assert.deepEqual(
        script.collectUnknownIds(
            ['111', '222', '333'],
            ['444'],
            idToName,
            undefined
        ),
        ['222', '333', '444']
    );
});

const NOT_FOUND_KEY = script.PLAYER_NAMES_NOT_FOUND_KEY;

test('player names not-found: wersjonowany klucz, TTL, rozłączność', () => {
    assert.equal(NOT_FOUND_KEY, 'travianAlliancePlayerNamesNotFound_v1');
    assert.notEqual(NOT_FOUND_KEY, script.PLAYER_NAMES_STORAGE_KEY);
    assert.notEqual(NOT_FOUND_KEY, script.SETTINGS_STORAGE_KEY);
    assert.equal(script.NAME_NOT_FOUND_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('not-found load/save bez localStorage: bezpieczne no-opy', () => {
    assert.deepEqual(script.loadPlayerNamesNotFound(), {});
    assert.equal(script.savePlayerNamesNotFound({ a: 1 }), undefined);
});

test('loadPlayerNamesNotFound: brak wpisu / zły JSON / zły kształt -> {}', () => {
    withLocalStorage({}, () => {
        assert.deepEqual(script.loadPlayerNamesNotFound(), {});
    });
    withLocalStorage({ [NOT_FOUND_KEY]: '{oops' }, () => {
        assert.deepEqual(script.loadPlayerNamesNotFound(), {});
    });
    withLocalStorage({ [NOT_FOUND_KEY]: '["a"]' }, () => {
        assert.deepEqual(script.loadPlayerNamesNotFound(), {});
    });
});

test('not-found save/load: roundtrip przez localStorage', () => {
    withLocalStorage({}, (map) => {
        const notFound = { [HOST]: { '1450': 1700000000000 } };

        script.savePlayerNamesNotFound(notFound);

        assert.deepEqual(script.loadPlayerNamesNotFound(), notFound);
        assert.equal(map[NOT_FOUND_KEY], JSON.stringify(notFound));
    });
});

test('markPlayerNamesNotFound: dodaje ID z timestampem, bez mutacji', () => {
    const now = 1700000000000;
    const base = { [HOST]: { '1450': now } };
    const next = script.markPlayerNamesNotFound(
        base,
        HOST,
        ['1450', '222', '333'],
        now
    );

    assert.deepEqual(
        next,
        { [HOST]: { '1450': now, '222': now, '333': now } }
    );
    assert.deepEqual(base, { [HOST]: { '1450': now } });
    assert.notEqual(next, base);
});

test('markPlayerNamesNotFound: bez zmian -> ta sama referencja', () => {
    const now = 1700000000000;
    const notFound = { [HOST]: { '1450': now } };

    assert.equal(
        script.markPlayerNamesNotFound(notFound, HOST, ['1450'], now),
        notFound
    );
    assert.equal(
        script.markPlayerNamesNotFound(notFound, HOST, [], now),
        notFound
    );
    assert.equal(
        script.markPlayerNamesNotFound(notFound, HOST, ['', null], now),
        notFound
    );
    assert.equal(
        script.markPlayerNamesNotFound(notFound, HOST, '1450', now),
        notFound
    );
});

test('markPlayerNamesNotFound: hostname normalizowany do małych liter', () => {
    const next = script.markPlayerNamesNotFound(
        {},
        'CW.X2.INTERNATIONAL.TRAVIAN.COM',
        ['1450'],
        1700000000000
    );

    assert.deepEqual(next, { [HOST]: { '1450': 1700000000000 } });
});

test('buildNotFoundIdSet: świeże 404 w Set, po TTL wypadają', () => {
    const now = 1700000000000;
    const ttl = script.NAME_NOT_FOUND_TTL_MS;
    const notFound = {
        [HOST]: {
            '1450': now,
            '222': now - ttl + 1,
            '333': now - ttl - 1,
            '444': 'not-a-number'
        }
    };

    assert.deepEqual(
        [...script.buildNotFoundIdSet(notFound, HOST, now)].sort(),
        ['1450', '222']
    );
});

test('buildNotFoundIdSet: inny świat i złe wejścia -> pusty Set', () => {
    assert.deepEqual(
        [...script.buildNotFoundIdSet(
            { 'other.world.travian.com': { '1450': Date.now() } },
            HOST,
            Date.now()
        )],
        []
    );
    assert.deepEqual(
        [...script.buildNotFoundIdSet({}, HOST, Date.now())],
        []
    );
    assert.deepEqual(
        [...script.buildNotFoundIdSet(['bad'], HOST, Date.now())],
        []
    );
});

test('runNameBackfill: 60 profili respektuje limit sześciu i kontynuuje po błędach', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const completed = [];
    const ids = Array.from({ length: 60 }, (_, index) => String(index + 1));
    const result = await script.runNameBackfill(ids, {
        concurrency: script.NAME_BACKFILL_MAX_CONCURRENCY,
        timeoutMs: script.NAME_BACKFILL_TIMEOUT_MS,
        fetchProfile: async (id) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(resolve => setImmediate(resolve));
            inFlight -= 1;
            completed.push(id);
            return id === '1' || id === '2'
                ? { ok: false, status: 500 }
                : { ok: true, status: 200, text: async () => `<h1 class="titleInHeader">Player ${id}</h1>` };
        }
    });
    assert.equal(maxInFlight, 6);
    assert.equal(result.resolved.length, 58);
    assert.deepEqual(result.failedIds.sort(), ['1', '2']);
    assert.equal(completed.length, 60);
    assert.equal(script.NAME_NOT_FOUND_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('extractNameFromProfileHtml: h1.titleInHeader -> nazwa', () => {
    const html = '<div class="wrapper">' +
        '<h1 class="titleInHeader">Sorryeu</h1></div>';

    assert.equal(script.extractNameFromProfileHtml(html), 'Sorryeu');
});

test('extractNameFromProfileHtml: dekodowanie encji HTML', () => {
    assert.equal(
        script.extractNameFromProfileHtml(
            '<h1 class="titleInHeader">M&amp;M&#39;s</h1>'
        ),
        "M&M's"
    );
    assert.equal(
        script.extractNameFromProfileHtml(
            '<h1 class="titleInHeader">A &lt; B &gt; C</h1>'
        ),
        'A < B > C'
    );
    assert.equal(
        script.extractNameFromProfileHtml(
            '<h1 class="titleInHeader">&quot;Q&quot; &#123;x&#125;</h1>'
        ),
        '"Q" {x}'
    );
});

test('extractNameFromProfileHtml: brak titleInHeader albo pusty -> null', () => {
    assert.equal(
        script.extractNameFromProfileHtml('<h1>Sorryeu</h1>'),
        null
    );
    assert.equal(
        script.extractNameFromProfileHtml(
            '<div class="titleInHeader">Sorryeu</div>'
        ),
        null
    );
    assert.equal(
        script.extractNameFromProfileHtml(
            '<h1 class="titleInHeader"></h1>'
        ),
        null
    );
    assert.equal(
        script.extractNameFromProfileHtml(
            '<h1 class="titleInHeader">   </h1>'
        ),
        null
    );
    assert.equal(script.extractNameFromProfileHtml(''), null);
    assert.equal(script.extractNameFromProfileHtml(null), null);
    assert.equal(script.extractNameFromProfileHtml(undefined), null);
});

// ---------------------------------------------------------------------------
// raidWord
// ---------------------------------------------------------------------------

test('raidWord: 1 -> raid, wszystko inne -> raids', () => {
    assert.equal(script.raidWord(1), 'raid');
    assert.equal(script.raidWord(0), 'raids');
    assert.equal(script.raidWord(2), 'raids');
    assert.equal(script.raidWord(null), 'raids');
    assert.equal(script.raidWord('1'), 'raids'); // string != 1 (number)
});

// ---------------------------------------------------------------------------
// shouldKeepWaitingForDrain (drain wait przed reloadem)
// ---------------------------------------------------------------------------

test('shouldKeepWaitingForDrain: aktywny + elapsed < maxWait -> true', () => {
    assert.equal(script.shouldKeepWaitingForDrain(true, 1000, 5000), true);
    assert.equal(script.shouldKeepWaitingForDrain(true, 0, 5000), true);
});

test('shouldKeepWaitingForDrain: nieaktywny / złe limity / wyczerpany budżet -> false', () => {
    assert.equal(script.shouldKeepWaitingForDrain(false, 1000, 5000), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, 5000, 5000), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, 6000, 5000), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, 1000, 0), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, 1000, -1), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, 1000, NaN), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, NaN, 5000), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, -1, 5000), false);
    assert.equal(script.shouldKeepWaitingForDrain(true, Infinity, 5000), false);
});

// ---------------------------------------------------------------------------
// recordFailure (diagnostyka)
// ---------------------------------------------------------------------------

test('recordFailure: ustawia lastFailure dla świata, inne światy nietknięte', () => {
    const base = {
        'inny.swiat': {
            lastFailure: { atMs: 1, statusOrError: 'old', eventCount: 1 }
        }
    };
    const next = script.recordFailure(
        base,
        HOST,
        1700000000000,
        'timeout',
        3
    );
    assert.deepEqual(next[HOST], {
        lastFailure: {
            atMs: 1700000000000,
            statusOrError: 'timeout',
            eventCount: 3
        }
    });
    assert.deepEqual(next['inny.swiat'], base['inny.swiat']);
    assert.notEqual(next, base, 'nowy obiekt');
    assert.equal(base[HOST], undefined, 'wejście nie mutowane');
});

test('recordFailure: nadpisuje najświeższą porażkę, fallbacki dla złych typów', () => {
    const base = {
        [HOST]: {
            lastFailure: { atMs: 1, statusOrError: 'a', eventCount: 1 }
        }
    };
    const next = script.recordFailure(base, HOST, 2, null, null);
    assert.deepEqual(next[HOST].lastFailure, {
        atMs: 2,
        statusOrError: 'null',
        eventCount: 0
    });
    // atMs bez wartości -> defensywny Date.now()
    const noClock = script.recordFailure({}, HOST, undefined, 'network', 1);
    assert.equal(typeof noClock[HOST].lastFailure.atMs, 'number');
});

test('recordFailure: persists only a closed rejection reason and bounded counters', () => {
    const next = script.recordFailure({}, HOST, 7, 'invalid-snapshot', 0, 'no-member-table', {
        memberRows: 0, icons: 2, rows: 4
    });
    assert.deepEqual(next[HOST].lastFailure, {
        atMs: 7,
        statusOrError: 'invalid-snapshot',
        eventCount: 0,
        rejectionReason: 'no-member-table',
        memberRows: 0,
        icons: 2,
        rows: 4
    });
    const unknown = script.recordFailure({}, HOST, 8, 'invalid-snapshot', 0, 'player-name-leak', {
        memberRows: 1, icons: 1, rows: 1
    });
    assert.equal(unknown[HOST].lastFailure.rejectionReason, undefined);
});

test('diagnostic rejection payload is redacted to codes and counters', () => {
    const persisted = JSON.stringify(script.recordFailure({}, HOST, 9, 'invalid-snapshot', 0,
        'no-member-table', {
            memberRows: 999999, rows: -4, icons: Infinity
        }));
    for (const forbidden of ['Player Name', '/profile/900001', 'raw tooltip', 'webhook', 'cookie', '<@900001>']) {
        assert.equal(persisted.includes(forbidden), false, forbidden);
    }
    assert.match(persisted, /"memberRows":10000/);
    assert.match(persisted, /"rejectionReason":"no-member-table"/);
});

// ---------------------------------------------------------------------------
// Kolejka inFlight (warstwa retry)
// ---------------------------------------------------------------------------

test('inFlight: addInFlightChunk / getInFlightChunks FIFO i kopia', () => {
    const batch = script.addInFlightChunk({}, HOST, {
        events: [makeEvent('A', '/p/1')],
        attemptCount: 0
    });
    const chunks = script.getInFlightChunks(batch, HOST);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].events, [makeEvent('A', '/p/1')]);
    assert.equal(chunks[0].attemptCount, 0);

    // kolejny chunk ląduje na końcu
    const second = script.addInFlightChunk(batch, HOST, {
        events: [makeEvent('B', '/p/2')],
        attemptCount: 1
    });
    const two = script.getInFlightChunks(second, HOST);
    assert.deepEqual(two.map(c => c.events[0].name), ['A', 'B']);
    assert.deepEqual(two.map(c => c.attemptCount), [0, 1]);

    // wynik to kopia — mutacja nie zmienia paczki
    two.pop();
    assert.equal(script.getInFlightChunks(second, HOST).length, 2);
});

test('inFlight: brak wpisu -> [], zły chunk pomijany', () => {
    assert.deepEqual(script.getInFlightChunks({}, HOST), []);
    assert.deepEqual(
        script.getInFlightChunks({ [HOST]: { events: [] } }, HOST),
        []
    );
    const skipped = script.addInFlightChunk({}, HOST, null);
    assert.deepEqual(script.getInFlightChunks(skipped, HOST), []);
    const badChunk = script.addInFlightChunk({}, HOST, { events: null });
    assert.deepEqual(script.getInFlightChunks(badChunk, HOST), [{
        events: [],
        attemptCount: 0
    }]);
});

test('inFlight: dropInFlightHead usuwa głowę; brak wpisu -> ta sama paczka', () => {
    let batch = script.addInFlightChunk({}, HOST, {
        events: [makeEvent('A', '/p/1')],
        attemptCount: 0
    });
    batch = script.addInFlightChunk(batch, HOST, {
        events: [makeEvent('B', '/p/2')],
        attemptCount: 0
    });
    const after = script.dropInFlightHead(batch, HOST);
    assert.deepEqual(
        script.getInFlightChunks(after, HOST).map(c => c.events[0].name),
        ['B']
    );
    assert.notEqual(after, batch);

    // ostatni chunk -> pusta lista, wpis świata zostaje
    const emptied = script.dropInFlightHead(after, HOST);
    assert.deepEqual(script.getInFlightChunks(emptied, HOST), []);

    // brak wpisu -> ta sama referencja
    const emptyBatch = {};
    assert.equal(script.dropInFlightHead(emptyBatch, HOST), emptyBatch);
    assert.equal(script.dropInFlightHead(batch, 'inny.swiat'), batch);
});

test('inFlight: replaceInFlightHeadAttempt aktualizuje tylko głowę', () => {
    let batch = script.addInFlightChunk({}, HOST, {
        events: [makeEvent('A', '/p/1')],
        attemptCount: 0
    });
    batch = script.addInFlightChunk(batch, HOST, {
        events: [makeEvent('B', '/p/2')],
        attemptCount: 0
    });
    const next = script.replaceInFlightHeadAttempt(batch, HOST, 2);
    assert.deepEqual(
        script.getInFlightChunks(next, HOST).map(c => c.attemptCount),
        [2, 0]
    );
    // zła wartość -> zachowany dotychczasowy attemptCount
    const keep = script.replaceInFlightHeadAttempt(batch, HOST, 'x');
    assert.deepEqual(
        script.getInFlightChunks(keep, HOST).map(c => c.attemptCount),
        [0, 0]
    );
    // pusta kolejka / brak wpisu -> ta sama paczka
    const emptyBatch = {};
    assert.equal(
        script.replaceInFlightHeadAttempt(emptyBatch, HOST, 1),
        emptyBatch
    );
    assert.equal(
        script.replaceInFlightHeadAttempt(batch, 'inny.swiat', 1),
        batch
    );
});

// ---------------------------------------------------------------------------
// Modele panelu (build*PanelModel / buildHistoryPanelRows)
// ---------------------------------------------------------------------------

test('buildHistoryPanelRows: kształt wierszy, limit, brakujące liczniki -> 0', () => {
    const now = 1700000000000;
    const rows = script.buildHistoryPanelRows([
        {
            name: 'Alice',
            eventType: 'join',
            priority: 'normal',
            addedAttackCount: 0,
            addedRaidCount: 0,
            detectedAtMs: now
        },
        { name: 'Bob' },
        null
    ], 2);
    assert.deepEqual(rows, [
        {
            name: 'Alice',
            eventType: 'join',
            priority: 'normal',
            addedAttack: 0,
            addedRaid: 0,
            detectedAt: new Date(now).toLocaleString()
        },
        {
            name: 'Bob',
            eventType: '—',
            priority: '—',
            addedAttack: 0,
            addedRaid: 0,
            detectedAt: '—'
        }
    ]);
    assert.deepEqual(
        script.buildHistoryPanelRows([makeEvent('A', '/p/1')], 0),
        []
    );
    assert.deepEqual(script.buildHistoryPanelRows(null, 5), []);
});

test('buildStatsPanelModel: domyślne zera i passthrough last24h', () => {
    const zeros = {
        total: 0,
        attacks: 0,
        raids: 0,
        mixed: 0,
        attackDelta: 0,
        raidDelta: 0,
        playerCount: 0,
        muted: 0,
        thresholdBlocked: 0,
        last24h: {
            total: 0,
            attacks: 0,
            raids: 0,
            mixed: 0,
            attackDelta: 0,
            raidDelta: 0,
            playerCount: 0,
            muted: 0,
            thresholdBlocked: 0
        }
    };
    assert.deepEqual(script.buildStatsPanelModel(null), zeros);

    const model = script.buildStatsPanelModel({
        total: 10,
        attacks: 5,
        raids: 3,
        mixed: 2,
        attackDelta: 7,
        raidDelta: 4,
        playerCount: 6,
        muted: 1,
        thresholdBlocked: 2,
        last24h: { total: 4, attacks: 2 }
    });
    assert.equal(model.total, 10);
    assert.equal(model.attacks, 5);
    assert.equal(model.mixed, 2);
    assert.equal(model.last24h.total, 4);
    assert.equal(model.last24h.attacks, 2);
    assert.equal(model.last24h.raids, 0, 'brakujące pola last24h -> 0');
    assert.equal(model.last24h.playerCount, 0);
    assert.equal(model.last24h.muted, 0);
});

test('buildDiagnosticsPanelModel: null bez failure; pola z failure', () => {
    assert.equal(script.buildDiagnosticsPanelModel(null), null);
    assert.equal(script.buildDiagnosticsPanelModel('x'), null);
    assert.deepEqual(
        script.buildDiagnosticsPanelModel({
            atMs: 1700000000000,
            statusOrError: 'timeout',
            eventCount: 3
        }),
        {
            at: new Date(1700000000000).toLocaleString(),
    releaseId: 'taa-6.2.1',
            statusOrError: 'timeout',
            eventCount: 3
        }
    );
    // statusOrError undefined -> '—', eventCount nie-liczbowy -> 0
    assert.deepEqual(
        script.buildDiagnosticsPanelModel({ atMs: 1 }),
        {
            at: new Date(1).toLocaleString(),
    releaseId: 'taa-6.2.1',
            statusOrError: '—',
            eventCount: 0
        }
    );
});

test('DiagnosticsPanelModel and scan summary expose the same safe rejection reason', () => {
    const failure = {
        atMs: 1700000000000,
        statusOrError: 'invalid-snapshot',
        eventCount: 0,
        rejectionReason: 'no-member-table',
        memberRows: 0,
        icons: 0,
        rows: 0
    };
    assert.equal(script.buildDiagnosticsPanelModel(failure).rejectionReason, 'no-member-table');
    const summary = script.buildScanSummaryLog({ status: 'rejected', rejectionReason: 'no-member-table', memberRows: 0, icons: 0 });
    assert.match(summary, /"rejectionReason":"no-member-table"/);
});

test('DiagnosticsPanelModel safely renders legacy and malformed reasons without replacing roster data', () => {
    assert.equal(script.buildDiagnosticsPanelModel({ atMs: 1, statusOrError: 'invalid-snapshot', eventCount: 0 }).rejectionReason, undefined);
    const malformed = script.buildDiagnosticsPanelModel({
        atMs: 1, statusOrError: 'invalid-snapshot', eventCount: 0, rejectionReason: 'Player Name <https://example.invalid/profile/900001>'
    });
    assert.equal(malformed.rejectionReason, undefined);
    assert.deepEqual({ playerId: '900001', name: 'Roster-safe' }, { playerId: '900001', name: 'Roster-safe' });
});

test('rejected scan reason persists as one reason-only V2 trace and reconciles into incident bundle', () => {
    const failure = script.recordFailure({}, HOST, 7, 'invalid-snapshot', 0, 'malformed-count', {
        memberRows: 1, rows: 1, icons: 2
    });
    const world = script.appendDiagnosticTraceV2(script.createDiagnosticsWorldV2(HOST), {
        stage: 'snapshot', status: 'rejected', reason: 'malformed-count'
    });
    const trace = world.records.at(-1);
    assert.deepEqual(trace, {
        schemaVersion: 2, sequence: 1, stage: 'snapshot', status: 'rejected', reason: 'malformed-count'
    });
    assert.equal(failure[HOST].lastFailure.rejectionReason, 'malformed-count');
    const model = script.buildCountReconciliationPanelModel({ traces: world.records });
    assert.equal(model.scanReason, 'malformed-count');
    assert.equal(model.scanOutcome, 'rejected');
    const bundle = script.buildIncidentBundle({ traces: world.records, diagnostics: failure, envelope: {} });
    assert.equal(bundle.scan.reason, 'malformed-count');
    assert.equal(bundle.scan.outcome, 'rejected');
    assert.deepEqual(Object.keys(trace).sort(), ['reason', 'schemaVersion', 'sequence', 'stage', 'status']);
});

test('authoritative scan trace becomes the latest result without stale rejection', () => {
    const traces = [
        { sequence: 1, stage: 'snapshot', status: 'rejected', reason: 'malformed-count' },
        { sequence: 2, stage: 'snapshot', status: 'ok', reason: 'authoritative' }
    ];
    const model = script.buildCountReconciliationPanelModel({ traces });
    const bundle = script.buildIncidentBundle({ traces, envelope: {} });
    assert.equal(model.scanOutcome, 'ok');
    assert.equal(model.scanReason, 'authoritative');
    assert.deepEqual(bundle.scan, { id: null, reason: 'authoritative', outcome: 'ok' });
});

test('legacy diagnostics without V2 trace still render safely', () => {
    const model = script.buildCountReconciliationPanelModel({
        diagnostics: { scanReason: 'malformed-count', scanOutcome: 'rejected' }, traces: []
    });
    const panel = script.buildDiagnosticsPanelModel({
        atMs: 1, statusOrError: 'invalid-snapshot', eventCount: 0, rejectionReason: 'malformed-count'
    });
    assert.equal(model.scanReason, 'malformed-count');
    assert.equal(model.scanOutcome, 'rejected');
    assert.equal(panel.rejectionReason, 'malformed-count');
});

test('rejected scan diagnostics and bundle remain private with sentinel-rich rows', () => {
    const sentinelRow = {
        id: '900001', name: 'SynthAlpha', url: `${HOST}/profile/900001`,
        tooltip: 'tooltip sentinel text', webhook: 'https://discord.com/api/webhooks/sentinel',
        cookie: 'cookie-sentinel', response: 'response sentinel'
    };
    const world = script.appendDiagnosticTraceV2(script.createDiagnosticsWorldV2(HOST), {
        stage: 'snapshot', status: 'rejected', reason: 'malformed-count'
    });
    const bundle = script.buildIncidentBundle({
        traces: world.records, diagnostics: script.recordFailure({}, HOST, 7, 'invalid-snapshot', 0, 'malformed-count', sentinelRow),
        envelope: { pending: [], inFlight: [], failed: [], uncertain: [], metrics: {} }, webhookConfigured: true
    });
    const serialized = JSON.stringify(bundle);
    assert.deepEqual(world.records[0], {
        schemaVersion: 2, sequence: 1, stage: 'snapshot', status: 'rejected', reason: 'malformed-count'
    });
    for (const sentinel of Object.values(sentinelRow)) assert.equal(serialized.includes(sentinel), false, sentinel);
});

test('reconciliation boundary rejects adversarial caller fields but preserves safe contracts', () => {
    const sentinel = 'PLAYER_ROW_PROFILE_WEBHOOK_PAYLOAD_COOKIE_RESPONSE_SENTINEL';
    const adversarial = script.buildIncidentBundle({
        routeRole: 'https://evil.example/' + sentinel,
        traces: [{ sequence: 1, stage: 'snapshot', status: 'ok', reason: 'authoritative', scanId: 'https://evil.example/' + sentinel }],
        envelope: { metrics: { conservation: { firstMismatch: { player: sentinel, url: 'https://evil.example/profile/1', webhook: sentinel, payload: sentinel, cookie: sentinel, response: sentinel } } } }
    });
    const serialized = JSON.stringify(adversarial);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(adversarial.routeRole, 'unknown');
    assert.equal(adversarial.scan.id, null);
    assert.equal(adversarial.conservation.firstMismatch, null);

    const safe = script.buildCountReconciliationPanelModel({
        routeRole: 'canonical-member',
        traces: [{ sequence: 1, stage: 'snapshot', status: 'ok', reason: 'authoritative', scanId: 'sc1:abcd1234' }],
        envelope: { metrics: { conservation: { firstMismatch: 'source-count-mismatch' } } }
    });
    assert.equal(safe.routeRole, 'canonical-member');
    assert.equal(safe.scanId, 'sc1:abcd1234');
    assert.equal(safe.firstConservationMismatch, 'source-count-mismatch');
    assert.equal(script.buildCountReconciliationPanelModel({ routeRole: 'unsupported', traces: [{ sequence: 1, stage: 'snapshot', status: 'ok', reason: 'authoritative', scanId: 'abcd1234' }] }).scanId, 'abcd1234');
});

test('malformed trace values degrade without throwing or leaking row data', () => {
    const malformed = { stage: {}, status: [], reason: { id: '900001', name: 'SynthAlpha', tooltip: 'tooltip sentinel text' } };
    const world = script.appendDiagnosticTraceV2(script.createDiagnosticsWorldV2(HOST), malformed);
    assert.equal(world.records.length, 1);
    assert.equal(JSON.stringify(world.records).includes('900001'), false);
    assert.equal(JSON.stringify(world.records).includes('SynthAlpha'), false);
});

test('buildStatusPanelModel: never domyślne, nextReloadInMs = max(0, next-now)', () => {
    const never = script.buildStatusPanelModel(null, null, 1000);
    assert.equal(never.lastScan, 'never');
    assert.equal(never.nextReload, 'never');
    assert.equal(never.nextReloadInMs, null);

    const future = script.buildStatusPanelModel(
        1700000000000,
        1700000005000,
        1700000000000
    );
    assert.equal(
        future.lastScan,
        new Date(1700000000000).toLocaleString()
    );
    assert.equal(
        future.nextReload,
        new Date(1700000005000).toLocaleString()
    );
    assert.equal(future.nextReloadInMs, 5000);

    const past = script.buildStatusPanelModel(0, 1000, 5000);
    assert.equal(past.nextReloadInMs, 0, 'przeszły reload -> 0, nie ujemna');
});

// ---------------------------------------------------------------------------
// Skład sojuszu (roster): join/leave
// ---------------------------------------------------------------------------

const ROSTER_KEY = script.ROSTER_STORAGE_KEY;

test('roster: wersjonowany klucz storage, rozłączny od pozostałych', () => {
    assert.equal(ROSTER_KEY, 'travianAllianceRoster_v1');
    assert.notEqual(ROSTER_KEY, script.SETTINGS_STORAGE_KEY);
    assert.notEqual(ROSTER_KEY, script.HISTORY_STORAGE_KEY);
    assert.notEqual(ROSTER_KEY, script.PENDING_BATCH_STORAGE_KEY);
    assert.notEqual(ROSTER_KEY, script.FAILED_BATCH_STORAGE_KEY);
    assert.notEqual(ROSTER_KEY, script.TAB_LEASE_STORAGE_KEY);
    assert.notEqual(ROSTER_KEY, NAMES_KEY);
    assert.notEqual(ROSTER_KEY, NOT_FOUND_KEY);
});

test('loadRoster/saveRoster bez localStorage: bezpieczne no-opy', () => {
    assert.deepEqual(script.loadRoster(), {});
    assert.equal(script.saveRoster({ a: 1 }), undefined);
});

test('loadRoster: brak wpisu / zły JSON / zły kształt -> {}', () => {
    withLocalStorage({}, () => {
        assert.deepEqual(script.loadRoster(), {});
    });
    withLocalStorage({ [ROSTER_KEY]: '{oops' }, () => {
        assert.deepEqual(script.loadRoster(), {});
    });
    withLocalStorage({ [ROSTER_KEY]: '["a"]' }, () => {
        assert.deepEqual(script.loadRoster(), {});
    });
    withLocalStorage({ [ROSTER_KEY]: 'null' }, () => {
        assert.deepEqual(script.loadRoster(), {});
    });
});

test('saveRoster/loadRoster: roundtrip przez localStorage', () => {
    withLocalStorage({}, (map) => {
        const roster = {
            [HOST]: {
                '385': { name: 'Sorryeu', url: 'https://x/profile/385' }
            }
        };
        script.saveRoster(roster);
        assert.deepEqual(script.loadRoster(), roster);
        assert.equal(map[ROSTER_KEY], JSON.stringify(roster));
    });
});

test('buildRosterMap: mapa id -> {name, url}, ostatni wygrywa', () => {
    assert.deepEqual(
        script.buildRosterMap([
            { id: '1', name: 'Alpha', url: '/p/1' },
            { id: '2', name: '  Beta  ', url: '/p/2' },
            { id: '3', name: 'Gamma', url: '/p/3' },
            { id: '3', name: 'Gamma2', url: '/p/3b' }
        ]),
        {
            '1': { name: 'Alpha', url: '/p/1' },
            '2': { name: 'Beta', url: '/p/2' },
            '3': { name: 'Gamma2', url: '/p/3b' }
        }
    );
});

test('buildRosterMap: puste/złe wpisy pomijane, nie-tablica -> {}', () => {
    assert.deepEqual(script.buildRosterMap(null), {});
    assert.deepEqual(script.buildRosterMap([
        { id: '', name: 'NoId' },
        { id: '1', name: '   ' },
        { id: null, name: 'NullId' },
        { id: 385, name: 'NumberId' },   // id musi być stringiem
        { name: 'NoIdField' },
        'not-an-object'
    ]), {});
});

test('diffRoster: null previous -> wszystko joined, changed=true', () => {
    const result = script.diffRoster(null, {
        '999': { name: 'Zulu', url: '/p/999' }
    });
    assert.deepEqual(result.joined, [
        { id: '999', name: 'Zulu', url: '/p/999' }
    ]);
    assert.deepEqual(result.left, []);
    assert.equal(result.changed, true);
});

test('diffRoster: joined i left razem, stare nazwy dla left', () => {
    const previous = {
        '135': { name: 'Terminator', url: '/p/135' },
        '999': { name: 'Zulu', url: '/p/999' }
    };
    const current = {
        '135': { name: 'Terminator', url: '/p/135' },
        '777': { name: 'Newcomer', url: '/p/777' }
    };
    const result = script.diffRoster(previous, current);
    assert.deepEqual(result.joined, [
        { id: '777', name: 'Newcomer', url: '/p/777' }
    ]);
    assert.deepEqual(result.left, [
        { id: '999', name: 'Zulu', url: '/p/999' }
    ]);
    assert.equal(result.changed, true);
});

test('roster leave events preserve stable playerId and resolve mapped mentions', () => {
    const options = compactOptions({
        leaveRoleId: ROLE,
        userIds: [UID_A]
    });
    const leave = {
        playerId: '999',
        name: 'Departed',
        url: '/profile/999',
        attackCount: 0,
        raidCount: 0,
        addedAttackCount: 0,
        addedRaidCount: 0,
        eventType: 'leave'
    };
    const payload = script.buildDiscordPayloads([leave], options)[0];

    assert.equal(payload.content, `<@&${ROLE}> <@${UID_A}>`);
    assert.deepEqual(payload.allowed_mentions, {
        users: [UID_A],
        roles: [ROLE]
    });
    assert.equal(payload.embeds[0].description.includes('<@'), false);
});

test('compact mentions select both roles once for mixed attack and leave batches', () => {
    const payload = script.buildDiscordPayloads([
        { name: 'Attacker', url: '/profile/1', attackCount: 1, raidCount: 0, addedAttackCount: 1, addedRaidCount: 0, eventType: 'attack' },
        { playerId: '2', name: 'Leaver', url: '/profile/2', attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0, eventType: 'leave' }
    ], compactOptions({ roleId: ROLE, leaveRoleId: UID_B, userIds: [UID_A] }))[0];

    assert.equal(payload.content, `<@&${ROLE}> <@&${UID_B}> <@${UID_A}>`);
    assert.deepEqual(payload.allowed_mentions, {
        users: [UID_A],
        roles: [ROLE, UID_B]
    });
});

test('compact mentions keep continuations role-free and bound 180 users', () => {
    const users = Array.from({ length: 180 }, (_, index) =>
        String(10000000000000000000n + BigInt(index))
    );
    const events = Array.from({ length: 60 }, (_, index) => ({
        name: `Long ${index} ${'x'.repeat(80)}`,
        url: `/profile/${index + 1}`,
        attackCount: 1,
        raidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack'
    }));
    const payloads = script.buildDiscordPayloads(events, compactOptions({
        roleId: ROLE,
        userIds: users
    }));

    assert.ok(payloads.length > 1);
    assert.ok(payloads[0].content.length <= 2000);
    assert.equal(payloads[0].allowed_mentions.roles[0], ROLE);
    for (const payload of payloads.slice(1)) {
        assert.deepEqual(payload.allowed_mentions, { users: [] });
        assert.equal(JSON.stringify(payload).includes(ROLE), false);
    }
});

test('diffRoster: rename (ten sam ID) -> brak zmian; brak zmian -> changed=false', () => {
    assert.deepEqual(
        script.diffRoster(
            { '1': { name: 'Old' } },
            { '1': { name: 'New' } }
        ),
        { joined: [], left: [], changed: false }
    );
    assert.deepEqual(
        script.diffRoster(
            { '1': { name: 'Same' } },
            { '1': { name: 'Same' } }
        ),
        { joined: [], left: [], changed: false }
    );
});

test('diffRoster: nie mutuje wejść', () => {
    const previous = { '1': { name: 'A', url: '/p/1' } };
    const current = { '1': { name: 'A', url: '/p/1' }, '2': { name: 'B' } };
    const prevCopy = JSON.parse(JSON.stringify(previous));
    const currCopy = JSON.parse(JSON.stringify(current));
    script.diffRoster(previous, current);
    assert.deepEqual(previous, prevCopy);
    assert.deepEqual(current, currCopy);
});

// ---------------------------------------------------------------------------
// Todo 3: verified per-world monitor envelope and migration
// ---------------------------------------------------------------------------

function makeMonitorMember(id, name, attackCount = 0, raidCount = 0) {
    return {
        name,
        url: `/profile/${id}`,
        attackCount,
        raidCount
    };
}

function makeMonitorSnapshot(membersById) {
    return {
        status: 'authoritative',
        observedAtMs: 1700000000000,
        tableSignature: 'alliance-members-v1:test',
        membersById,
        anomalies: {
            missingId: false,
            duplicateId: false,
            conflictingTooltip: false,
            malformedCount: false,
            paginationOrFilter: false
        }
    };
}

function makeMonitorMemory() {
    const values = new Map();
    const writes = [];

    return {
        values,
        writes,
        get(key) {
            return values.has(key) ? values.get(key) : undefined;
        },
        set(key, value) {
            writes.push({ key, value });
            values.set(key, value);
        }
    };
}

test('MonitorEnvelopeV1: canonical integrity roundtrip rejects envelope-shaped corruption', () => {
    const envelope = script.createMonitorEnvelopeV1(HOST, {
        generation: 4,
        baselineByPlayerId: {
            '101': makeMonitorMember('101', 'Alpha', 2, 1)
        }
    });
    const serialized = script.serializeMonitorEnvelopeV1(envelope);
    const parsed = script.parseMonitorEnvelopeV1(serialized);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.envelope, envelope);
    assert.equal(
        script.canonicalSerializeMonitorValue({ b: 1, a: 2 }),
        '{"a":2,"b":1}'
    );

    const corrupt = JSON.parse(serialized);
    corrupt.baselineByPlayerId['101'].attackCount = 99;
    const rejected = script.parseMonitorEnvelopeV1(JSON.stringify(corrupt));

    assert.equal(rejected.ok, false);
    assert.equal(rejected.outcome, 'corrupt');
});

test('MonitorEnvelopeV1: generations are fenced monotonically', () => {
    assert.equal(script.compareMonitorGenerations(2, 1), 1);
    assert.equal(script.compareMonitorGenerations(2, 2), 0);
    assert.equal(script.compareMonitorGenerations(1, 2), -1);
    assert.equal(script.isMonitorGenerationFenced(4, 5), true);
    assert.equal(script.isMonitorGenerationFenced(5, 5), false);
});

test('legacy name->ID migration carries unique counts, seeds ambiguity, and emits zero alerts', () => {
    const snapshot = makeMonitorSnapshot({
        '101': makeMonitorMember('101', 'Alpha', 8, 2),
        '102': makeMonitorMember('102', 'Same', 5, 5),
        '103': makeMonitorMember('103', 'Same', 7, 7)
    });
    const plan = script.planMonitorLegacyMigration({
        attackState: {
            Alpha: { attackCount: 3, raidCount: 1 },
            Same: { attackCount: 99, raidCount: 99 },
            Unknown: { attackCount: 44, raidCount: 44 },
            filterVersion: 4
        },
        pending: {
            [HOST]: {
                createdAt: 1700000000123,
                events: [{ id: '101', eventType: 'attack', addedAttackCount: 1 }]
            }
        }
    }, snapshot, HOST);

    assert.equal(plan.migrationAmbiguities, 2);
    assert.deepEqual(plan.baselineByPlayerId['101'], {
        name: 'Alpha',
        url: '/profile/101',
        attackCount: 3,
        raidCount: 1
    });
    assert.equal(plan.baselineByPlayerId['102'].attackCount, 5);
    assert.equal(plan.baselineByPlayerId['103'].raidCount, 7);
    assert.deepEqual(plan.events, []);
    assert.equal(plan.pending[0].observedAtMs, 1700000000123);
    assert.equal(plan.pending[0].observedAtApproximate, true);
});

test('monitor queue coalescing: earliest observation, latest totals, FIFO, and roster opposition', () => {
    const events = [
        {
            world: HOST,
            playerId: '101',
            eventType: 'attack',
            addedAttackCount: 1,
            addedRaidCount: 0,
            attackCount: 3,
            raidCount: 1,
            observedAtMs: 20,
            name: 'Old',
            url: '/profile/101'
        },
        {
            world: HOST,
            playerId: '202',
            eventType: 'raid',
            addedAttackCount: 0,
            addedRaidCount: 2,
            attackCount: 1,
            raidCount: 4,
            observedAtMs: 10
        },
        {
            world: HOST,
            playerId: '101',
            eventType: 'attack',
            addedAttackCount: 2,
            addedRaidCount: 1,
            attackCount: 5,
            raidCount: 2,
            observedAtMs: 10,
            name: 'New',
            url: '/profile/101?fresh=1'
        },
        { world: HOST, playerId: '303', eventType: 'join', observedAtMs: 1 },
        { world: HOST, playerId: '303', eventType: 'leave', observedAtMs: 2 }
    ];
    const result = script.coalesceMonitorPendingEvents(events);

    assert.equal(result.ok, true);
    assert.deepEqual(result.events.map(event => event.playerId), [
        '101', '202', '303', '303'
    ]);
    assert.equal(result.events[0].eventType, 'mixed');
    assert.equal(result.events[0].addedAttackCount, 3);
    assert.equal(result.events[0].addedRaidCount, 1);
    assert.equal(result.events[0].observedAtMs, 10);
    assert.equal(result.events[0].attackCount, 5);
    assert.equal(result.events[0].name, 'New');
});

test('monitor queue hard bound rejects whole 513-record candidate without truncation', () => {
    const pending = Array.from({ length: 513 }, (_, index) => ({
        world: HOST,
        playerId: String(index),
        eventType: 'attack',
        addedAttackCount: 1,
        addedRaidCount: 0,
        observedAtMs: index
    }));
    const result = script.coalesceMonitorPendingEvents(pending, 512, 1700000000999);

    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'bound-exhausted');
    assert.equal(result.events.length, 0);
    assert.equal(result.blockedQueueAtMs, 1700000000999);
});

test('monitor commit: backup then active readbacks gate memory swap and reject stale generation', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, {
        generation: 1,
        baselineByPlayerId: { '101': makeMonitorMember('101', 'Alpha', 1, 0) }
    });
    const candidate = script.createMonitorEnvelopeV1(HOST, {
        generation: 2,
        baselineByPlayerId: { '101': makeMonitorMember('101', 'Alpha', 2, 0) }
    });
    storage.values.set(script.monitorActiveStorageKey(HOST), script.serializeMonitorEnvelopeV1(old));
    storage.values.set(script.monitorBackupStorageKey(HOST), script.serializeMonitorEnvelopeV1(old));

    const committed = script.commitMonitorEnvelopeV1({
        world: HOST,
        currentEnvelope: old,
        candidateEnvelope: candidate,
        storage
    });

    assert.equal(committed.outcome, 'ok');
    assert.equal(committed.envelope.generation, 2);
    assert.equal(committed.memorySwapped, true);
    assert.equal(script.parseMonitorEnvelopeV1(storage.get(script.monitorBackupStorageKey(HOST))).envelope.generation, 1);

    const fenced = script.commitMonitorEnvelopeV1({
        world: HOST,
        currentEnvelope: candidate,
        candidateEnvelope: candidate,
        storage
    });
    assert.equal(fenced.outcome, 'fenced-reject');
});

test('monitor commit: lease loss between backup and active writes leaves storage unchanged', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, { generation: 1 });
    const candidate = script.createMonitorEnvelopeV1(HOST, { generation: 2 });
    const activeKey = script.monitorActiveStorageKey(HOST);
    const backupKey = script.monitorBackupStorageKey(HOST);
    storage.values.set(activeKey, script.serializeMonitorEnvelopeV1(old));
    storage.values.set(backupKey, script.serializeMonitorEnvelopeV1(old));
    const before = new Map(storage.values);
    let fenceChecks = 0;

    const result = script.commitMonitorEnvelopeV1({
        world: HOST,
        currentEnvelope: old,
        candidateEnvelope: candidate,
        storage,
        beforeCommit: () => {
            fenceChecks += 1;
            return fenceChecks === 1;
        }
    });

    assert.equal(result.outcome, 'fenced-reject');
    assert.equal(result.memorySwapped, false);
    assert.equal(fenceChecks, 2);
    assert.deepEqual(storage.values, before);
});

test('loadMonitorEnvelopeV1: valid envelope from another world is quarantined and blocked', () => {
    const storage = makeMonitorMemory();
    const worldA = HOST;
    const worldB = 'ts2.example.com';
    const foreign = script.createMonitorEnvelopeV1(worldB, { generation: 4 });
    storage.values.set(
        script.monitorActiveStorageKey(worldA),
        script.serializeMonitorEnvelopeV1(foreign)
    );

    const result = script.loadMonitorEnvelopeV1(worldA, {
        storage,
        nowMs: 1700000000000
    });

    assert.equal(result.outcome, 'corrupt-active');
    assert.equal(result.blocked, true);
    assert.ok(result.quarantineKeys.length > 0);
});

test('loadMonitorEnvelopeV1: persisted queue with 513 pending records is bound-exceeded and blocked', () => {
    const storage = makeMonitorMemory();
    const oversized = script.createMonitorEnvelopeV1(HOST, {
        generation: 5,
        pending: Array.from({ length: 513 }, (_, index) => ({
            eventId: `oversized-${index}`,
            world: HOST,
            playerId: String(index),
            eventType: 'attack'
        }))
    });
    storage.values.set(
        script.monitorActiveStorageKey(HOST),
        script.serializeMonitorEnvelopeV1(oversized)
    );

    const result = script.loadMonitorEnvelopeV1(HOST, {
        storage,
        nowMs: 1700000000000
    });

    assert.equal(result.outcome, 'bound-exceeded');
    assert.equal(result.blocked, true);
    assert.ok(result.quarantineKeys.length > 0);
});

test('monitor commit: active write failure preserves old active, backup, and memory', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, { generation: 1 });
    const candidate = script.createMonitorEnvelopeV1(HOST, { generation: 2 });
    const activeKey = script.monitorActiveStorageKey(HOST);
    const backupKey = script.monitorBackupStorageKey(HOST);
    storage.values.set(activeKey, script.serializeMonitorEnvelopeV1(old));
    storage.values.set(backupKey, script.serializeMonitorEnvelopeV1(old));
    const originalSet = storage.set.bind(storage);
    let activeAttempt = false;
    storage.set = (key, value) => {
        if (key === activeKey && !activeAttempt) {
            activeAttempt = true;
            throw new Error('injected active write failure');
        }
        originalSet(key, value);
    };

    const result = script.commitMonitorEnvelopeV1({
        world: HOST,
        currentEnvelope: old,
        candidateEnvelope: candidate,
        storage
    });

    assert.equal(result.outcome, 'wrote-failed');
    assert.equal(result.memorySwapped, false);
    assert.equal(script.parseMonitorEnvelopeV1(storage.get(activeKey)).envelope.generation, 1);
    assert.equal(script.parseMonitorEnvelopeV1(storage.get(backupKey)).envelope.generation, 1);
});

test('monitor commit: readback mismatch is typed and leaves both generations unchanged', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, { generation: 3 });
    const candidate = script.createMonitorEnvelopeV1(HOST, { generation: 4 });
    const activeKey = script.monitorActiveStorageKey(HOST);
    const backupKey = script.monitorBackupStorageKey(HOST);
    storage.values.set(activeKey, script.serializeMonitorEnvelopeV1(old));
    storage.values.set(backupKey, script.serializeMonitorEnvelopeV1(old));
    const originalSet = storage.set.bind(storage);
    let activeWrites = 0;
    storage.set = (key, value) => {
        originalSet(key, value);
        if (key === activeKey && activeWrites === 0) {
            activeWrites += 1;
            storage.values.set(key, value + 'corrupt');
        }
    };

    const result = script.commitMonitorEnvelopeV1({
        world: HOST,
        currentEnvelope: old,
        candidateEnvelope: candidate,
        storage
    });

    assert.equal(result.outcome, 'readback-mismatch');
    assert.equal(result.memorySwapped, false);
    assert.equal(script.parseMonitorEnvelopeV1(storage.get(activeKey)).envelope.generation, 3);
    assert.equal(script.parseMonitorEnvelopeV1(storage.get(backupKey)).envelope.generation, 3);
});

test('monitor queue transitions: enqueue, in-flight, acknowledge, retry, failed, uncertain, and requeue are typed', () => {
    const base = script.createMonitorEnvelopeV1(HOST, {
        generation: 1,
        pending: [{ eventId: 'a', world: HOST, playerId: '101', eventType: 'attack' }]
    });
    const transition = (type, extra = {}) =>
        script.applyMonitorQueueTransitionV1(base, Object.assign({ type }, extra));

    const enqueued = transition('enqueue', {
        events: [{ eventId: 'b', world: HOST, playerId: '202', eventType: 'raid' }]
    });
    assert.equal(enqueued.outcome, 'ok');
    assert.equal(enqueued.envelope.pending.length, 2);

    const inFlight = script.applyMonitorQueueTransitionV1(
        enqueued.envelope,
        { type: 'pending-to-inFlight' }
    );
    assert.equal(inFlight.outcome, 'ok');
    assert.equal(inFlight.envelope.pending.length, 0);
    assert.equal(inFlight.envelope.inFlight.length, 2);

    const acknowledged = script.applyMonitorQueueTransitionV1(
        inFlight.envelope,
        { type: 'acknowledge', eventIds: ['a'] }
    );
    assert.equal(acknowledged.outcome, 'ok');
    assert.equal(acknowledged.envelope.inFlight.length, 1);

    const retried = script.applyMonitorQueueTransitionV1(
        acknowledged.envelope,
        { type: 'retry' }
    );
    assert.equal(retried.outcome, 'ok');
    assert.equal(retried.envelope.pending.length, 1);

    const failed = script.applyMonitorQueueTransitionV1(
        retried.envelope,
        { type: 'pending-to-inFlight' }
    );
    const failedResult = script.applyMonitorQueueTransitionV1(
        failed.envelope,
        { type: 'failed' }
    );
    assert.equal(failedResult.outcome, 'ok');
    assert.equal(failedResult.envelope.failed.length, 1);

    const uncertainResult = script.applyMonitorQueueTransitionV1(
        failedResult.envelope,
        { type: 'uncertain' }
    );
    assert.equal(uncertainResult.outcome, 'ok');
    assert.equal(uncertainResult.envelope.uncertain.length, 0);

    const requeued = script.applyMonitorQueueTransitionV1(
        failedResult.envelope,
        { type: 'requeue-failed' }
    );
    assert.equal(requeued.outcome, 'ok');
    assert.equal(requeued.envelope.failed.length, 0);
    assert.equal(requeued.envelope.pending.length, 1);
});

test('loadOrMigrateMonitorEnvelopeV1: storage marker makes startup migration one-shot', () => {
    const storage = makeMonitorMemory();
    const snapshot = makeMonitorSnapshot({
        '101': makeMonitorMember('101', 'Alpha', 6, 0)
    });
    const legacy = {
        attackState: {
            Alpha: { attackCount: 6, raidCount: 0 },
            filterVersion: 4
        }
    };
    const first = script.loadOrMigrateMonitorEnvelopeV1(HOST, snapshot, {
        storage,
        legacy,
        nowMs: 1700000000000
    });
    const second = script.loadOrMigrateMonitorEnvelopeV1(HOST, snapshot, {
        storage,
        legacy: {
            attackState: {
                Alpha: { attackCount: 100, raidCount: 100 },
                filterVersion: 4
            }
        },
        nowMs: 1700000001000
    });

    assert.equal(first.outcome, 'migrated');
    assert.equal(second.outcome, 'ok');
    assert.equal(second.envelope.migration.completedAtMs, 1700000000000);
    assert.equal(second.envelope.baselineByPlayerId['101'].attackCount, 6);
});

test('monitor recovery: corrupt active is quarantined verbatim and valid backup recovers; two corrupt states block', () => {
    const storage = makeMonitorMemory();
    const backup = script.createMonitorEnvelopeV1(HOST, { generation: 7 });
    const corruptActive = '{"schemaVersion":1,"world":"' + HOST + '","integrity":"bad"}';
    storage.values.set(script.monitorActiveStorageKey(HOST), corruptActive);
    storage.values.set(script.monitorBackupStorageKey(HOST), script.serializeMonitorEnvelopeV1(backup));
    const recovered = script.loadMonitorEnvelopeV1(HOST, { storage, nowMs: 1700000000123 });

    assert.equal(recovered.outcome, 'recovered-from-backup');
    assert.equal(recovered.envelope.generation, 7);
    assert.equal(storage.get(recovered.quarantineKeys[0]), corruptActive);

    storage.values.set(script.monitorActiveStorageKey(HOST), corruptActive);
    storage.values.set(script.monitorBackupStorageKey(HOST), '{"broken":true}');
    const blocked = script.loadMonitorEnvelopeV1(HOST, { storage, nowMs: 1700000000999 });

    assert.equal(blocked.outcome, 'corrupt-backup');
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.canExport, true);
    assert.equal(blocked.canReset, true);
});

test('monitor migration marker prevents repeated legacy import and webhook key stays dedicated', () => {
    const snapshot = makeMonitorSnapshot({
        '101': makeMonitorMember('101', 'Alpha', 4, 0)
    });
    const first = script.migrateLegacyMonitorStateV1({
        world: HOST,
        snapshot,
        legacy: {
            attackState: { Alpha: { attackCount: 4, raidCount: 0 }, filterVersion: 4 }
        },
        nowMs: 10
    });
    const second = script.migrateLegacyMonitorStateV1({
        world: HOST,
        snapshot,
        legacy: {
            attackState: { Alpha: { attackCount: 999, raidCount: 999 }, filterVersion: 4 }
        },
        existingEnvelope: first.envelope,
        nowMs: 20
    });

    assert.equal(first.outcome, 'migrated');
    assert.equal(first.events.length, 0);
    assert.equal(second.outcome, 'already-complete');
    assert.equal(second.envelope.baselineByPlayerId['101'].attackCount, 4);
    assert.equal(script.WEBHOOK_STORAGE_KEY, 'travianAllianceWebhookUrl_v1');
    assert.notEqual(script.WEBHOOK_STORAGE_KEY, script.MONITOR_ACTIVE_STORAGE_KEY_PREFIX);
});

test('applyEventThresholds: join/leave przechodzą bez liczników, nawet przy progu > 0', () => {
    const high = script.validateSettings({
        attackThreshold: 99,
        raidThreshold: 99
    });
    const passing = script.applyEventThresholds([
        { eventType: 'join' },
        { eventType: 'leave' },
        { eventType: 'attack', addedAttackCount: 1 }
    ], high);
    assert.deepEqual(
        passing.map(e => e.eventType),
        ['join', 'leave']
    );
    assert.equal(
        script.applyEventThresholds(
            [{ eventType: 'join' }],
            script.getDefaultSettings()
        ).length,
        1
    );
});

test('filterMutedEvents: join/leave wyciszonego gracza zostają', () => {
    const mutes = { [HOST]: { '385': true } };
    const events = [
        {
            name: 'MutedJoin',
            url: 'https://x.travian.com/profile/385',
            eventType: 'join'
        },
        {
            name: 'MutedLeave',
            url: 'https://x.travian.com/profile/385',
            eventType: 'leave'
        },
        {
            name: 'MutedAttack',
            url: 'https://x.travian.com/profile/385',
            eventType: 'attack'
        }
    ];
    const kept = script.filterMutedEvents(events, HOST, mutes);
    assert.deepEqual(
        kept.map(e => e.eventType),
        ['join', 'leave']
    );
});

test('buildEventDescriptionLine: roster lines stay compact and textual', () => {
    const ctx = { origin: ORIGIN, fallbackHref: FALLBACK_HREF };

    assert.equal(
        script.buildEventDescriptionLine({
            eventType: 'join',
            name: 'Zulu',
            url: 'https://cw.x2.international.travian.com/profile/999'
        }, 1, ctx),
        'Zulu — joined the alliance'
    );
    assert.equal(
        script.buildEventDescriptionLine({
            eventType: 'leave',
            name: 'M&M',
            url: 'https://cw.x2.international.travian.com/profile/385'
        }, 2, ctx),
        'M&M — left the alliance'
    );
    // escapowanie markdowna w nazwie
    const escaped = script.buildEventDescriptionLine({
        eventType: 'join',
        name: 'A)b(',
        url: '/profile/1'
    }, null, ctx);
    assert.ok(escaped.includes('joined the alliance'));
    assert.ok(!escaped.includes('A)b('), 'nawiasy w nazwie escapowane');
});

test('enqueueEvents: roundtrip eventType join/leave przez snapshot', () => {
    const batch = script.enqueueEvents({}, HOST, [
        {
            name: 'Zulu',
            url: '/profile/999',
            attackCount: 0,
            raidCount: 0,
            oldAttackCount: 0,
            oldRaidCount: 0,
            addedAttackCount: 0,
            addedRaidCount: 0,
            eventType: 'join'
        },
        {
            name: 'Terminator',
            url: '/profile/135',
            attackCount: 0,
            raidCount: 0,
            oldAttackCount: 0,
            oldRaidCount: 0,
            addedAttackCount: 0,
            addedRaidCount: 0,
            eventType: 'leave'
        }
    ]);
    const snapshot = script.snapshotBatch(batch, HOST);
    assert.deepEqual(
        snapshot.events.map(e => e.eventType),
        ['join', 'leave']
    );
    assert.deepEqual(snapshot.events[0], {
        name: 'Zulu',
        url: '/profile/999',
        attackCount: 0,
        raidCount: 0,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 0,
        addedRaidCount: 0,
        eventType: 'join'
    });
});

// ---------------------------------------------------------------------------
// Todo 2: autorytatywny snapshot tabeli członków (ID + jeden przebieg wierszy)
// ---------------------------------------------------------------------------

function snapshotRow(id, name, icons = [], extra = {}) {
    return Object.assign({
        id,
        name,
        url: `/profile/${id}`,
        icons
    }, extra);
}

function snapshotIcon(tooltip, attributes = {}) {
    return Object.assign({
        className: 'attack',
        tooltipSources: [tooltip]
    }, attributes);
}

function snapshotTable(rows, extra = {}) {
    return Object.assign({ rows }, extra);
}

function domNode({ text = '', attributes = {}, className = '', rows = [], links = [], images = [] } = {}) {
    const node = {
        textContent: text,
        className,
        parentElement: null,
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name)
                ? attributes[name]
                : null;
        },
        querySelectorAll(selector) {
            if (selector === 'tr') return rows;
            if (selector === 'a') return links;
            if (selector === 'img') return images;
            if (selector.includes('a[href*=')) return links;
            return [];
        }
    };
    node.classList = { contains: name => className.split(/\s+/).includes(name) };
    return node;
}

function domLink(id, name) {
    return domNode({ text: name, attributes: { href: `/profile/${id}` } });
}

function domMemberRow(id, name, tooltip) {
    const link = domLink(id, name);
    const image = domNode({
        className: 'attack',
        attributes: { 'data-tooltip': tooltip }
    });
    const row = domNode({ links: [link], images: [image] });
    image.parentElement = row;
    return row;
}

function domTable(rows) {
    const links = rows.flatMap(row => row.querySelectorAll('a'));
    return domNode({ rows, links });
}

function contractTable(rows, attributes = {}) {
    const table = domTable(rows);
    table.className = 'allianceMembers';
    table.getAttribute = name => Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : name === 'class' ? 'allianceMembers' : null;
    return table;
}

test('member-table contract rejects every closed table-selection reason', () => {
    const member = contractTable([domMemberRow('101', 'Alpha', '2 attacks')]);
    const cases = [
        ['no-member-table', { querySelectorAll: selector => selector === 'table' ? [] : [] }],
        ['multiple-member-tables', { querySelectorAll: selector => selector === 'table' ? [member, member] : [] }],
        ['pagination-or-filter', { querySelectorAll: selector => selector === 'table' ? [contractTable(member.querySelectorAll('tr'), { 'data-pagination': 'true' })] : [] }],
        ['missing-player-id', { querySelectorAll: selector => selector === 'table' ? [contractTable([domNode({ images: [domNode({ className: 'attack', attributes: { title: '1 attack' } })] })])] : [] }],
        ['duplicate-player-id', { querySelectorAll: selector => selector === 'table' ? [contractTable([domMemberRow('101', 'Alpha', '1 attack'), domMemberRow('101', 'Beta', '2 attacks')])] : [] }],
        ['conflicting-tooltip', { querySelectorAll: selector => {
            if (selector !== 'table') return [];
            const table = contractTable([domMemberRow('101', 'Alpha', '1 attack')]);
            const icon = table.querySelectorAll('tr')[0].querySelectorAll('img')[0];
            icon.getAttribute = name => name === 'data-tooltip' ? '1 attack' : name === 'title' ? '2 attacks' : null;
            return [table];
        } }],
        ['malformed-count', { querySelectorAll: selector => selector === 'table' ? [contractTable([domMemberRow('101', 'Alpha', 'zero attacks')])] : [] }]
    ];

    for (const [reason, documentFixture] of cases) {
        const result = script.parseMemberSnapshot(documentFixture, 2000);
        assert.equal(result.status, 'rejected', reason);
        assert.equal(result.reason, reason, reason);
    }
});

test('member-table contract accepts authoritative 60/59 fixture shapes and exact incident sum', () => {
    const rows = Array.from({ length: 60 }, (_, index) => domMemberRow(String(index + 1), `Player ${index + 1}`, ''));
    const full = script.parseMemberSnapshot({ querySelectorAll: selector => selector === 'table' ? [contractTable(rows)] : [] }, 2100);
    assert.equal(full.status, 'authoritative');
    assert.equal(Object.keys(full.membersById).length, 60);

    const incidentRows = rows.slice(0, 59);
    incidentRows[0] = domMemberRow('1', 'Player 1', '1 attack');
    incidentRows[1] = domMemberRow('2', 'Player 2', '1 attack');
    const incident = script.parseMemberSnapshot({ querySelectorAll: selector => selector === 'table' ? [contractTable(incidentRows)] : [] }, 2200);
    assert.equal(incident.status, 'authoritative');
    assert.equal(Object.keys(incident.membersById).length, 59);
    assert.equal(Object.values(incident.membersById).reduce((sum, row) => sum + row.attackCount, 0), 2);
});

test('authoritative snapshot: attack-only, raid-only i mixed są ID-keyed', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('2 attacks')]),
        snapshotRow('102', 'Beta', [snapshotIcon('3 raids')]),
        snapshotRow('103', 'Gamma', [snapshotIcon('4 attacks, 1 raid')])
    ]), 1700000000000);

    assert.equal(snapshot.status, 'authoritative');
    assert.equal(snapshot.observedAtMs, 1700000000000);
    assert.deepEqual(snapshot.anomalies, {
        missingId: false,
        duplicateId: false,
        conflictingTooltip: false,
        malformedCount: false,
        paginationOrFilter: false
    });
    assert.deepEqual(snapshot.membersById, {
        '101': { name: 'Alpha', url: '/profile/101', attackCount: 2, raidCount: 0 },
        '102': { name: 'Beta', url: '/profile/102', attackCount: 0, raidCount: 3 },
        '103': { name: 'Gamma', url: '/profile/103', attackCount: 4, raidCount: 1 }
    });
    assert.match(snapshot.tableSignature, /^alliance-members-v1:/);
});

test('member-table selection: members beat summary and decoy tables', () => {
    const summary = domTable([domMemberRow('201', 'Summary', '99 attacks')]);
    const members = contractTable([
        domMemberRow('101', 'Alpha', '2 attacks'),
        domMemberRow('102', 'Beta', '3 raids'),
        domMemberRow('103', 'Gamma', '4 attacks, 1 raid')
    ]);
    const decoy = domTable([
        domMemberRow('901', 'Attack target', '88 attacks'),
        domMemberRow('902', 'Raid target', '77 raids')
    ]);
    const documentFixture = {
        location: { origin: 'https://cw.x2.international.travian.com' },
        querySelectorAll(selector) {
            return selector === 'table' ? [summary, members, decoy] : [];
        }
    };

    const snapshot = script.extractAllianceSnapshotFromDocument(documentFixture, 1400);

    assert.equal(snapshot.status, 'authoritative');
    assert.deepEqual(Object.keys(snapshot.membersById), ['101', '102', '103']);
    assert.equal(snapshot.membersById['103'].raidCount, 1);
});

test('tooltip parsing: attack-only, raid-only, mixed, malformed, and duplicate sources', () => {
    assert.deepEqual(
        script.parseNormalizedMemberIcon(snapshotIcon('2 attacks')),
        { attackCount: 2, raidCount: 0, hasEvent: true, conflictingTooltip: false, malformedCount: false }
    );
    assert.deepEqual(
        script.parseNormalizedMemberIcon(snapshotIcon('3 raids')),
        { attackCount: 0, raidCount: 3, hasEvent: true, conflictingTooltip: false, malformedCount: false }
    );
    assert.deepEqual(
        script.parseNormalizedMemberIcon(snapshotIcon('4 attacks, 1 raid')),
        { attackCount: 4, raidCount: 1, hasEvent: true, conflictingTooltip: false, malformedCount: false }
    );
    assert.equal(script.parseNormalizedMemberIcon(snapshotIcon('-1 attacks')).malformedCount, true);
    assert.equal(script.parseNormalizedMemberIcon(snapshotIcon('2 attacks', {
        tooltipSources: ['2 attacks', '2 attacks']
    })).conflictingTooltip, false);
});

test('tooltip parsing: unsigned zeroes are valid, while numeric lookalikes stay malformed', () => {
    for (const tooltip of ['0 attacks', '00 attacks']) {
        assert.deepEqual(script.parseNormalizedMemberIcon(snapshotIcon(tooltip)), {
            attackCount: 0, raidCount: 0, hasEvent: false, conflictingTooltip: false, malformedCount: false
        });
    }
    for (const tooltip of ['0 raids', '00 raids']) {
        assert.deepEqual(script.parseNormalizedMemberIcon(snapshotIcon(tooltip)), {
            attackCount: 0, raidCount: 0, hasEvent: false, conflictingTooltip: false, malformedCount: false
        });
    }
    for (const tooltip of ['+0 attacks', '-0 attacks', '0.0 attacks', '0,0 attacks', '+1 attacks', '-1 attacks', '1.5 attacks', '1,5 attacks', 'NaN attacks', 'Infinity attacks', '∞ attacks', 'attack', 'raid', 'atak', 'grabież', 'non-numeric text attacks']) {
        assert.equal(script.parseNormalizedMemberIcon(snapshotIcon(tooltip)).malformedCount, true, tooltip);
    }
    assert.deepEqual(script.parseNormalizedMemberIcon(snapshotIcon('1 atak(ów) 0 grabieży')), {
        attackCount: 1, raidCount: 0, hasEvent: true, conflictingTooltip: false, malformedCount: false
    });
    assert.deepEqual(script.parseNormalizedMemberIcon(snapshotIcon('1 attack 0 raids')), {
        attackCount: 1, raidCount: 0, hasEvent: true, conflictingTooltip: false, malformedCount: false
    });
});

test('invalid and partial member tables never produce a commit candidate', () => {
    const previous = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('1 attack')])
    ]), 1500);
    const malformed = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('-1 attacks')]),
        snapshotRow('101', 'Duplicate', [snapshotIcon('2 attacks')])
    ]), 1600);
    const partial = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('2 attacks')])
    ], { paginationOrFilter: true }), 1700);

    assert.equal(script.diffAllianceSnapshots(previous, malformed).commit, false);
    assert.equal(script.diffAllianceSnapshots(previous, partial).commit, false);
    assert.deepEqual(script.diffAllianceSnapshots(previous, malformed).events, []);
});

test('authoritative snapshot: rename same ID changes metadata, not identity or deltas', () => {
    const previous = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'OldName', [snapshotIcon('2 attacks')])
    ]), 100);
    const current = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'NewName', [snapshotIcon('2 attacks')])
    ]), 200);

    assert.deepEqual(script.diffAllianceSnapshots(previous, current), {
        commit: true,
        events: [],
        current: current.membersById,
        observedAtMs: 200
    });
});

test('authoritative snapshot: icons outside selected table are ignored', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [])
    ], { outsideIcons: [snapshotIcon('99 attacks')] }), 300);

    assert.equal(snapshot.status, 'authoritative');
    assert.deepEqual(snapshot.membersById['101'], {
        name: 'Alpha',
        url: '/profile/101',
        attackCount: 0,
        raidCount: 0
    });
    assert.deepEqual(script.diffAllianceSnapshots(null, snapshot).events, []);
});

test('partial non-empty table: zero commit events and no omission-to-zero', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('5 attacks')])
    ], { paginationOrFilter: true }), 400);

    assert.equal(snapshot.status, 'partial');
    assert.equal(snapshot.anomalies.paginationOrFilter, true);
    assert.equal(script.diffAllianceSnapshots({
        status: 'authoritative',
        membersById: { '102': { name: 'Beta', url: '/profile/102', attackCount: 7, raidCount: 2 } }
    }, snapshot).commit, false);
    assert.deepEqual(script.diffAllianceSnapshots(null, snapshot).events, []);
});

test('duplicate ID conflict: invalid and produces no commit candidate', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('1 attack')]),
        snapshotRow('101', 'RenamedConflict', [snapshotIcon('4 attacks')])
    ]), 500);

    assert.equal(snapshot.status, 'invalid');
    assert.equal(snapshot.anomalies.duplicateId, true);
    assert.equal(script.diffAllianceSnapshots(null, snapshot).commit, false);
    assert.deepEqual(script.diffAllianceSnapshots(null, snapshot).events, []);
});

test('conflicting tooltip attributes: invalid and produces no commit candidate', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('2 attacks', {
            tooltipSources: ['2 attacks', '3 attacks']
        })])
    ]), 600);

    assert.equal(snapshot.status, 'invalid');
    assert.equal(snapshot.anomalies.conflictingTooltip, true);
    assert.deepEqual(script.diffAllianceSnapshots(null, snapshot).events, []);
});

test('non-empty roster with zero icons is authoritative empty-ready', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha'),
        snapshotRow('102', 'Beta')
    ]), 700);

    assert.equal(snapshot.status, 'authoritative');
    assert.deepEqual(snapshot.membersById['101'], {
        name: 'Alpha',
        url: '/profile/101',
        attackCount: 0,
        raidCount: 0
    });
});

test('zero-member table is invalid, not an authoritative empty snapshot', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([]), 800);

    assert.equal(snapshot.status, 'invalid');
    assert.deepEqual(snapshot.membersById, {});
    assert.equal(script.diffAllianceSnapshots(null, snapshot).commit, false);
});

test('roster partial drop: no roster advancement and no leave event', () => {
    const previous = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha'),
        snapshotRow('102', 'Beta')
    ]), 900);
    const partial = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha')
    ], { paginationOrFilter: true }), 1000);

    const diff = script.diffAllianceSnapshots(previous, partial);
    assert.equal(diff.commit, false);
    assert.deepEqual(diff.events, []);
    assert.deepEqual(script.migrationFriendlyCountRecords(partial), []);
});

test('missing ID, malformed positive count and missing-cell probes are explicit anomalies', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow(null, 'NoId', [snapshotIcon('1 attack')]),
        snapshotRow('102', 'BadCount', [snapshotIcon('-1 attacks')]),
        { id: '103', name: '', url: '', icons: [] }
    ]), 1100);

    assert.equal(snapshot.status, 'invalid');
    assert.equal(snapshot.anomalies.missingId, true);
    assert.equal(snapshot.anomalies.malformedCount, true);
    assert.deepEqual(script.diffAllianceSnapshots(null, snapshot).events, []);
});

test('table signature is stable for row order and changes for identity/count changes', () => {
    const left = snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('1 attack')]),
        snapshotRow('102', 'Beta')
    ]);
    const reordered = snapshotTable(left.rows.slice().reverse());
    const changed = snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('2 attacks')]),
        snapshotRow('102', 'Beta')
    ]);

    assert.equal(script.buildStableTableSignature(left), script.buildStableTableSignature(reordered));
    assert.notEqual(script.buildStableTableSignature(left), script.buildStableTableSignature(changed));
});

test('table signature structural rejection matrix preserves reason precedence', () => {
    const cases = [
        ['conflicting-tooltip', { querySelectorAll: selector => {
            if (selector !== 'table') return [];
            const table = contractTable([domMemberRow('101', 'Alpha', '1 attack')]);
            const icon = table.querySelectorAll('tr')[0].querySelectorAll('img')[0];
            icon.getAttribute = name => name === 'data-tooltip' ? '1 attack' : name === 'title' ? '2 attacks' : null;
            return [table];
        } }],
        ['missing-player-id', { querySelectorAll: selector => selector === 'table' ? [contractTable([domNode({ images: [domNode({ className: 'attack', attributes: { title: '1 attack' } })] })])] : [] }],
        ['duplicate-player-id', { querySelectorAll: selector => selector === 'table' ? [contractTable([domMemberRow('101', 'Alpha', '1 attack'), domMemberRow('101', 'Beta', '2 attacks')])] : [] }],
        ['pagination-or-filter', { querySelectorAll: selector => selector === 'table' ? [contractTable([domMemberRow('101', 'Alpha', '1 attack')], { 'data-pagination': 'true' })] : [] }]
    ];
    for (const [reason, documentFixture] of cases) {
        const result = script.parseMemberSnapshot(documentFixture, 2200);
        assert.equal(result.status, 'rejected', reason);
        assert.equal(result.reason, reason, reason);
    }
});

test('non-empty roster with zero icons: explicit zero icons equal absent icons for diff and commit', () => {
    const explicit = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('0 attacks 0 raids')])
    ]), 2300);
    const absent = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha')
    ]), 2300);

    assert.equal(explicit.status, 'authoritative');
    assert.equal(explicit.anomalies.malformedCount, false);
    assert.deepEqual(script.parseNormalizedMemberIcon(snapshotIcon('0 attacks 0 raids')), {
        attackCount: 0, raidCount: 0, hasEvent: false, conflictingTooltip: false, malformedCount: false
    });
    assert.deepEqual(script.diffAllianceSnapshots(null, explicit), script.diffAllianceSnapshots(null, absent));
    assert.equal(script.diffAllianceSnapshots(explicit, explicit).commit, true);
    assert.deepEqual(script.diffAllianceSnapshots(explicit, explicit).events, []);
});

test('migration-friendly count records retain stable IDs and mutable metadata', () => {
    const snapshot = script.buildAllianceSnapshot(snapshotTable([
        snapshotRow('101', 'Alpha', [snapshotIcon('2 attacks, 1 raid')])
    ]), 1200);

    assert.deepEqual(script.migrationFriendlyCountRecords(snapshot), [{
        id: '101',
        name: 'Alpha',
        url: '/profile/101',
        attackCount: 2,
        raidCount: 1
    }]);
});

test('one traversal: each normalized row and icon parser is called exactly once', () => {
    const rows = [
        snapshotRow('101', 'Alpha', [snapshotIcon('1 attack'), snapshotIcon('1 raid')]),
        snapshotRow('102', 'Beta', [snapshotIcon('2 attacks')])
    ];
    let rowCalls = 0;
    let iconCalls = 0;
    const snapshot = script.extractAllianceSnapshotFromRows(rows, {
        observedAtMs: 1300,
        parseRow(row, context) {
            rowCalls += 1;
            return script.parseNormalizedMemberRow(row, Object.assign({}, context, {
                parseIcon(icon, iconContext) {
                    iconCalls += 1;
                    return script.parseNormalizedMemberIcon(icon, iconContext);
                }
            }));
        }
    });

    assert.equal(snapshot.status, 'authoritative');
    assert.equal(rowCalls, rows.length);
    assert.equal(iconCalls, 3);
});

test('Todo 5 event contract: stable identity and honest timestamps survive normalization', () => {
    const event = script.createMonitorQueueEvent(
        {
            name: 'Alpha',
            url: '/profile/101',
            eventType: 'attack',
            addedAttackCount: 2,
            addedRaidCount: 0
        },
        { world: HOST, playerId: '101', observedAtMs: 1000, queuedAtMs: 1250 }
    );

    assert.equal(event.playerId, '101');
    assert.equal(event.observedAtMs, 1000);
    assert.equal(event.queuedAtMs, 1250);
    assert.equal(typeof event.eventId, 'string');
    assert.equal(event.approximateObserved, undefined);

    const same = script.createMonitorQueueEvent(
        Object.assign({}, event),
        { world: HOST, playerId: '101', observedAtMs: 1000, queuedAtMs: 1250 }
    );
    assert.equal(same.eventId, event.eventId);
});

test('Todo 5 queue age: exact records are measurable and legacy records are approximate', () => {
    assert.deepEqual(
        script.computeQueueAge({ observedAtMs: 1000, dispatchedAtMs: 3400 }),
        { ageMs: 2400, approximate: false }
    );
    assert.deepEqual(
        script.computeQueueAge({ observedAtMs: 1000, dispatchedAtMs: 3400, approximateObserved: true }),
        { ageMs: 2400, approximate: true }
    );
    assert.equal(script.computeQueueAge({ observedAtMs: 1000 }).ageMs, null);
});

test('Todo 5 Discord response taxonomy: acknowledgement requires a message id', () => {
    assert.deepEqual(
        script.classifyDiscordResponse({ status: 200, responseText: JSON.stringify({ id: 'message-1' }) }),
        { kind: 'acknowledged', messageId: 'message-1' }
    );
    assert.deepEqual(
        script.classifyDiscordResponse({ status: 200, responseText: '<html>accepted</html>' }),
        { kind: 'uncertain', responseClass: 'non-json-200' }
    );
    assert.deepEqual(
        script.classifyDiscordResponse({ status: 200, responseText: JSON.stringify({ ok: true }) }),
        { kind: 'uncertain', responseClass: 'malformed-json-200' }
    );
    assert.equal(script.classifyDiscordResponse({ status: 400, responseText: '{}' }).kind, 'permanent');
    assert.equal(script.classifyDiscordResponse({ status: 401, responseText: '{}' }).kind, 'permanent');
    assert.equal(script.classifyDiscordResponse({ status: 403, responseText: '{}' }).kind, 'permanent');
    assert.equal(script.classifyDiscordResponse({ status: 404, responseText: '{}' }).kind, 'permanent');
    assert.equal(script.classifyDiscordResponse({ status: 408, responseText: '{}' }).kind, 'retryable');
    assert.equal(script.classifyDiscordResponse({ status: 429, responseText: '{"retry_after": 99}' }).kind, 'retryable');
    assert.equal(script.classifyDiscordResponse({ status: null, errorClass: 'abort' }).kind, 'retryable');
});

test('Todo 5 transport fixture: wait URL is in-memory, retry-after is capped, malformed 200 is never retried', async () => {
    const canonical = 'https://discord.com/api/webhooks/123456789012345678/fake_token_test_only';
    const requests = [];
    const responses = [
        { status: 429, responseText: '{"retry_after": 99}' },
        { status: 200, responseText: JSON.stringify({ id: 'message-2' }) }
    ];
    const delays = [];
    const result = await script.sendDiscordPayloadWithRetry({
        webhookUrl: canonical,
        payload: { content: 'fixture' },
        maxAttempts: 3,
        sleep: async delay => delays.push(delay),
        gmRequest: options => {
            requests.push(options.url);
            options.onload(responses.shift());
        }
    });

    assert.equal(result.outcome.kind, 'acknowledged');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(url => url.includes('?wait=true')));
    assert.deepEqual(delays, [script.MAX_RETRY_DELAY_MS]);
    assert.equal(canonical.includes('wait=true'), false);

    const malformedRequests = [];
    const malformed = await script.sendDiscordPayloadWithRetry({
        webhookUrl: canonical,
        payload: {},
        maxAttempts: 3,
        sleep: async () => {
            throw new Error('malformed 200 must not sleep');
        },
        gmRequest: options => {
            malformedRequests.push(options.url);
            options.onload({ status: 200, responseText: 'accepted' });
        }
    });
    assert.deepEqual(malformed.outcome, { kind: 'uncertain', responseClass: 'non-json-200' });
    assert.equal(malformedRequests.length, 1);
});

test('Todo 5 durable queue transitions: dispatch timestamp is persisted before acknowledgement removes events', () => {
    const storage = makeMonitorMemory();
    const base = script.createMonitorEnvelopeV1(HOST, {
        generation: 1,
        pending: [script.createMonitorQueueEvent(
            { name: 'Alpha', url: '/profile/101', eventType: 'attack' },
            { world: HOST, playerId: '101', observedAtMs: 1000, queuedAtMs: 1100 }
        )]
    });
    const moved = script.commitMonitorQueueTransitionV1({
        world: HOST,
        currentEnvelope: base,
        expectedGeneration: 1,
        transition: { type: 'pending-to-inFlight' },
        storage
    });
    assert.equal(moved.outcome, 'ok');
    const started = script.commitMonitorQueueTransitionV1({
        world: HOST,
        currentEnvelope: moved.envelope,
        expectedGeneration: moved.envelope.generation,
        transition: { type: 'dispatch-start', eventIds: [moved.envelope.inFlight[0].eventId], atMs: 2500 },
        storage
    });
    assert.equal(started.outcome, 'ok');
    assert.equal(started.envelope.inFlight[0].dispatchedAtMs, 2500);
    const acknowledged = script.commitMonitorQueueTransitionV1({
        world: HOST,
        currentEnvelope: started.envelope,
        expectedGeneration: started.envelope.generation,
        transition: { type: 'acknowledge', eventIds: [started.envelope.inFlight[0].eventId] },
        storage
    });
    assert.equal(acknowledged.outcome, 'ok');
    assert.equal(acknowledged.envelope.inFlight.length, 0);
    assert.equal(script.parseMonitorEnvelopeV1(storage.get(script.monitorActiveStorageKey(HOST))).envelope.inFlight.length, 0);
});

test('Todo 5 durable queue transition failure preserves the old in-flight event', () => {
    const storage = makeMonitorMemory();
    const base = script.createMonitorEnvelopeV1(HOST, {
        generation: 1,
        inFlight: [{ eventId: 'durable-1', world: HOST, playerId: '101', eventType: 'attack' }]
    });
    storage.values.set(script.monitorActiveStorageKey(HOST), script.serializeMonitorEnvelopeV1(base));
    storage.values.set(script.monitorBackupStorageKey(HOST), script.serializeMonitorEnvelopeV1(base));
    const activeKey = script.monitorActiveStorageKey(HOST);
    storage.set = (key, value) => {
        if (key === activeKey) {
            throw new Error('storage unavailable');
        }
        storage.values.set(key, value);
    };
    const result = script.commitMonitorQueueTransitionV1({
        world: HOST,
        currentEnvelope: base,
        expectedGeneration: base.generation,
        transition: { type: 'acknowledge', eventIds: ['durable-1'] },
        storage
    });
    assert.notEqual(result.outcome, 'ok');
    assert.equal(script.parseMonitorEnvelopeV1(storage.values.get(activeKey)).envelope.inFlight.length, 1);
});

test('reload drain timeout preserves in-flight records for the next lifecycle', () => {
    const event = script.createMonitorQueueEvent(
        { name: 'Alpha', url: '/profile/101', eventType: 'attack' },
        { world: HOST, playerId: '101', observedAtMs: 1800, queuedAtMs: 1810 }
    );
    const envelope = script.createMonitorEnvelopeV1(HOST, {
        generation: 1,
        inFlight: [event]
    });
    const persisted = script.parseMonitorEnvelopeV1(
        script.serializeMonitorEnvelopeV1(envelope)
    ).envelope;

    assert.equal(
        script.shouldKeepWaitingForDrain(true, script.DRAIN_MAX_WAIT_MS, script.DRAIN_MAX_WAIT_MS),
        false
    );
    assert.deepEqual(persisted.inFlight.map(item => item.eventId), [event.eventId]);
});

test('Todo 5 programmable GM matrix: network, timeout, abort, 5xx retry, and 4xx permanent outcomes', async () => {
    const canonical = 'https://discord.com/api/webhooks/123456789012345678/fake_token_test_only';
    const run = async (response, expectedKind, expectedAttempts) => {
        let requests = 0;
        const result = await script.sendDiscordPayloadWithRetry({
            webhookUrl: canonical,
            payload: {},
            maxAttempts: 3,
            sleep: async () => {},
            gmRequest: options => {
                requests += 1;
                if (response.errorClass === 'throw') {
                    options.onerror({ reason: 'fixture' });
                } else if (response.errorClass === 'timeout') {
                    options.ontimeout();
                } else if (response.errorClass === 'abort') {
                    options.onabort();
                } else {
                    options.onload(response);
                }
            }
        });
        assert.equal(result.outcome.kind, expectedKind);
        assert.equal(requests, expectedAttempts);
    };

    await run({ errorClass: 'throw' }, 'retryable', 3);
    await run({ errorClass: 'timeout' }, 'retryable', 3);
    await run({ errorClass: 'abort' }, 'retryable', 3);
    await run({ status: 500, responseText: 'server failure' }, 'retryable', 3);
    await run({ status: 400, responseText: 'bad request' }, 'permanent', 1);
});

test('Todo 5 restart seam: legacy in-flight records migrate and remain sendable after reload', () => {
    const storage = makeMonitorMemory();
    const legacyEvent = {
        name: 'Alpha',
        url: '/profile/101',
        eventType: 'attack',
        addedAttackCount: 1,
        createdAt: 1700000000000
    };
    const loaded = script.loadOrMigrateMonitorEnvelopeV1(HOST, null, {
        storage,
        nowMs: 1700000000100,
        legacy: { inFlight: { [HOST]: { events: [legacyEvent], createdAt: 1700000000000 } } }
    });
    assert.equal(loaded.outcome, 'migrated');
    assert.equal(loaded.envelope.inFlight.length, 1);
    assert.equal(loaded.envelope.inFlight[0].approximateObserved, true);
    assert.equal(typeof loaded.envelope.inFlight[0].eventId, 'string');
});

test('Todo 8 draft model: persists only safe fields and restores focus offsets', () => {
    const storage = memoryStorage();
    const draft = script.createAdminDraftState('players', {
        'taa-player-search': 'A-17',
        webhookUrl: 'https://discord.com/api/webhooks/secret'
    }, { id: 'taa-player-search', start: 1, end: 3 });
    assert.deepEqual(draft.fields, { 'taa-player-search': 'A-17' });
    const saved = script.persistAdminDraft(storage, 'taa-draft:test:players', draft);
    assert.equal(saved.ok, true);
    const restored = script.restoreAdminDraft(storage, 'taa-draft:test:players');
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.draft, draft);
    assert.equal(storage.getItem('taa-draft:test:players').includes('webhook'), false);
});

test('Todo 8 draft gate: write-read-compare blocks throwing or mismatching storage', () => {
    const draft = script.createAdminDraftState('alerts', { threshold: '3' }, null);
    const good = script.gateAdminDraftReload(memoryStorage(), 'taa-draft:test:alerts', draft);
    assert.equal(good.outcome, 'readback-verified');
    const throwing = { setItem() { throw new Error('quota'); }, getItem() { return null; } };
    assert.equal(script.gateAdminDraftReload(throwing, 'taa-draft:test:alerts', draft).ok, false);
    const mismatch = { setItem() {}, getItem() { return 'changed'; } };
    assert.equal(script.gateAdminDraftReload(mismatch, 'taa-draft:test:alerts', draft).outcome, 'readback-mismatch');
});

test('hotfix caret restore: selection support excludes checkbox inputs', () => {
    const source = fs.readFileSync(require.resolve('../script.txt'), 'utf8');
    assert.match(source, /function supportsInputSelection\s*\(element\)/);
    assert.doesNotMatch(source, /typeof draftFocus\.setSelectionRange\s*===\s*['"]function['"]|typeof input\.setSelectionRange\s*===\s*['"]function['"]/);
    assert.equal((source.match(/supportsInputSelection\(draftFocus\)/g) || []).length, 1);
    assert.equal((source.match(/supportsInputSelection\(input\)/g) || []).length, 1);
    assert.match(source, /if \(supportsInputSelection\(draftFocus\)\)\s*\{[\s\S]{0,160}try\s*\{[\s\S]{0,120}draftFocus\.setSelectionRange/);
    assert.match(source, /if \(supportsInputSelection\(input\)\)\s*\{[\s\S]{0,160}try\s*\{[\s\S]{0,120}input\.setSelectionRange/);
    assert.equal(script.supportsInputSelection({ type: 'checkbox', setSelectionRange() {} }), false);
    assert.equal(script.supportsInputSelection({ type: 'text', setSelectionRange() {} }), true);
});

test('Todo 8 inventory: all panel capabilities have a structured tab surface', () => {
    const source = fs.readFileSync(require.resolve('../script.txt'), 'utf8');
    const workspaceStart = source.indexOf('const renderWorkspace');
    const workspace = source.slice(workspaceStart, source.indexOf('let pendingBackfillIds', workspaceStart));
    for (const capability of [
        'overview', 'players', 'alerts', 'diagnostics',
        'taa-player-search', 'taa-mapping-add',
         'taa-alert-save', 'taa-alert-role-save', 'taa-alert-test',
         'taa-leave-role', 'taa-leave-role-input', 'taa-leave-role-set', 'taa-leave-role-clear', 'taa-leave-role-current',
         'taa-diagnostics-export'
     ]) assert.match(workspace, new RegExp(capability));
     for (const removedControl of ['taa-alert-retry-failed', 'taa-alert-retry-uncertain', 'taa-alert-mark-delivered', 'taa-alert-flush', 'taa-diagnostics-load', 'taa-debug-toggle']) {
         assert.equal(workspace.includes(removedControl), false);
     }
     for (const menuLabel of ['Retry failed Discord batches', 'Retry uncertain Discord batches', 'Mark uncertain Discord batches delivered', 'Flush pending Discord batches', 'Load history and health', 'Toggle debug details']) {
         assert.match(source, new RegExp('GM_registerMenuCommand\\(\\s*[\'\"]' + menuLabel));
     }
     assert.match(workspace, /input\.id = "taa-filter-" \+ key/);
    assert.equal(workspace.includes('prompt('), false);
    assert.match(source, /GM_registerMenuCommand\(\s*['"]Set leave-moderator role ID/);
    assert.match(source, /GM_registerMenuCommand\(\s*['"]Clear leave-moderator role ID/);
    assert.match(source, /GM_registerMenuCommand\(\s*['"]Show leave-moderator role ID/);
    assert.match(source, /function loadSettings/);
    assert.match(source, /function saveSettings/);
    assert.match(source, /function loadHistory/);
    assert.match(source, /function loadFailedBatch/);
});

test('sanitized acquisition fixtures are deterministic and secret-free', () => {
    const first = acquisition.buildFixtures();
    const second = acquisition.buildFixtures();
    assert.deepEqual(first, second);
    for (const fixture of Object.values(first)) {
        assert.doesNotMatch(fixture.html, /<script\b|villageList|webhook|cookie|cdn\.|travian\.com/i);
        if (fixture.html.includes('data-route-role="authoritative"')) assert.match(fixture.html, /\/profile\/9\d{5}/);
        assert.doesNotMatch(fixture.html, /Antily|PiotrCropowy|Community Week|TRESUARY/i);
        assert.match(fixture.html, /<main data-route-role="[^"]+"/);
    }
});

test('sanitized acquisition fixtures preserve exact golden structure', () => {
    const contracts = acquisition.readGoldenContracts();
    assert.deepEqual(contracts['members-60'], {
        routeRole: 'authoritative', tableCount: 1, rowCount: 60, uniqueRowCount: 60,
        iconCount: 0, attackSum: 0, raidSum: 0, rejectionReason: null
    });
    assert.deepEqual(contracts['members-59-incident'], {
        routeRole: 'authoritative', tableCount: 1, rowCount: 59, uniqueRowCount: 59,
        iconCount: 2, attackSum: 2, raidSum: 0, rejectionReason: null
    });
    for (const name of ['overview', 'reports-paginated', 'report-detail']) {
        assert.equal(contracts[name].routeRole, 'non-authoritative');
        assert.match(contracts[name].rejectionReason, /^[a-z-]+$/);
    }
});

test('sanitized acquisition fixtures exercise the real DOM snapshot path', async () => {
    const snapshots = await acquisitionBrowser.extractFixtureSnapshots([
        'members-60', 'members-59-incident'
    ]);
    assert.equal(snapshots['members-60'].status, 'authoritative');
    assert.equal(Object.keys(snapshots['members-60'].membersById).length, 60);
    assert.equal(snapshots['members-59-incident'].status, 'authoritative');
    assert.equal(Object.keys(snapshots['members-59-incident'].membersById).length, 59);
    const incidentMembers = Object.values(snapshots['members-59-incident'].membersById);
    assert.equal(incidentMembers.reduce((sum, member) => sum + member.attackCount, 0), 2);
    assert.equal(incidentMembers.reduce((sum, member) => sum + member.raidCount, 0), 0);
    for (const member of Object.values(snapshots['members-59-incident'].membersById)) {
        assert.match(member.url, /\/profile\/\d+$/);
    }
});

test('paired zero counters browser extraction is authoritative', async () => {
    const result = await acquisitionBrowser.extractPairedZeroFixtureSnapshot();
    assert.equal(result.snapshot.status, 'authoritative');
    const counts = member => ({ attackCount: member.attackCount, raidCount: member.raidCount });
    assert.deepEqual(counts(result.snapshot.membersById['900001']), { attackCount: 1, raidCount: 0 });
    assert.deepEqual(counts(result.snapshot.membersById['900002']), { attackCount: 1, raidCount: 0 });
    assert.deepEqual(counts(result.snapshot.membersById['900003']), { attackCount: 0, raidCount: 0 });
    assert.equal(result.snapshot.anomalies.malformedCount, false);
    assert.equal(result.storageAfter, result.storageBefore);
});

test('sanitized acquisition fixtures contain only synthetic paired-zero data', () => {
    const source = fs.readFileSync(require('node:path').join(__dirname, 'fixtures/acquisition/paired-zero-members.html'), 'utf8');
    assert.match(source, /900001|900002|900003/);
    assert.match(source, /SynthAlpha|SynthBeta|SynthGamma/);
    assert.doesNotMatch(source, /cw\.x2\.international\.travian\.com|discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/i);
    assert.doesNotMatch(source, /Lenny|Quinnos|Ariadne|Borek|Ciri|Darek|sandla/i);
});

test('bare-word malformed count stays rejected in the browser without storage writes', async () => {
    const result = await acquisitionBrowser.extractRejectedFixtureSnapshots(['malformed-count']);
    assert.deepEqual(result['malformed-count'].snapshot, { status: 'rejected', reason: 'malformed-count' });
    assert.equal(result['malformed-count'].storageAfter, result['malformed-count'].storageBefore);
});

test('member-table contract rejects every reason without mutating state', async () => {
    const reasons = [
        'no-member-table', 'multiple-member-tables', 'pagination-or-filter',
        'missing-player-id', 'duplicate-player-id', 'conflicting-tooltip',
        'malformed-count'
    ];
    const results = await acquisitionBrowser.extractRejectedFixtureSnapshots(reasons);
    for (const reason of reasons) {
        assert.deepEqual(results[reason].snapshot, {
            status: 'rejected', reason
        });
        assert.deepEqual(results[reason].storageAfter, results[reason].storageBefore, reason);
        const diagnostics = script.recordFailure({}, HOST, 1700000000000, 'invalid-snapshot', 0, results[reason].snapshot.reason, {
            memberRows: 0, rows: 0, icons: 0
        });
        assert.equal(diagnostics[HOST].lastFailure.rejectionReason, reason);
    }
});

test('evidence runner self-test rejects unknown registry IDs', () => {
    assert.throws(() => evidenceRunner.resolveCase({ task: 999 }), /unknown task/i);
    assert.throws(() => evidenceRunner.resolveCase({ final: 'UNKNOWN' }), /unknown final/i);
});

test('conservation net delta: one player 0→8 is eight represented sources', () => {
    const sources = conservation.assignPositiveNetDeltas({
        world: 'fixture-world', generation: 1, scanSequence: 1,
        previous: { alpha: { attackCount: 0, raidCount: 0 } },
        current: { alpha: { attackCount: 8, raidCount: 0 } }
    });
    assert.equal(sources.length, 8);
    conservation.assertConservation({
        detections: [{ sourceEventIds: sources, disposition: 'eligible' }],
        delivery: { entries: [{ stage: 'pending', sourceEventIds: sources }], compactedTerminalTotals: [] }
    });
});

test('conservation net delta: multiple players and attacks+raids are source-disjoint', () => {
    const sources = conservation.assignPositiveNetDeltas({
        world: 'fixture-world', generation: 2, scanSequence: 4,
        previous: { alpha: { attackCount: 1, raidCount: 2 }, beta: { attackCount: 0, raidCount: 0 } },
        current: { alpha: { attackCount: 3, raidCount: 3 }, beta: { attackCount: 2, raidCount: 1 } }
    });
    assert.equal(sources.length, 6);
    assert.equal(new Set(sources).size, 6);
    conservation.assertConservation({
        detections: [{ sourceEventIds: sources.slice(0, 2), disposition: 'muted' }, { sourceEventIds: sources.slice(2), disposition: 'eligible' }],
        delivery: { entries: [{ stage: 'prepared', sourceEventIds: sources.slice(2) }], compactedTerminalTotals: [] }
    });
});

test('conservation net delta: 6→3→9 accepts the second delta as +6', () => {
    const first = conservation.assignPositiveNetDeltas({ world: 'w', generation: 3, scanSequence: 1, previous: { alpha: { attackCount: 6, raidCount: 0 } }, current: { alpha: { attackCount: 3, raidCount: 0 } } });
    const second = conservation.assignPositiveNetDeltas({ world: 'w', generation: 4, scanSequence: 2, previous: { alpha: { attackCount: 3, raidCount: 0 } }, current: { alpha: { attackCount: 9, raidCount: 0 } } });
    assert.deepEqual(first, []);
    assert.equal(second.length, 6);
});

test('conservation incident accounting: unchanged and decrease-only scans produce no sources', () => {
    for (const current of [{ attackCount: 6, raidCount: 2 }, { attackCount: 3, raidCount: 1 }]) {
        assert.deepEqual(conservation.assignPositiveNetDeltas({ world: 'w', generation: 5, scanSequence: 1, previous: { alpha: { attackCount: 6, raidCount: 2 } }, current: { alpha: current }}), []);
    }
});

test('conservation incident accounting: same-player reload detections coalesce without losing IDs', () => {
    const a = conservation.assignPositiveNetDeltas({ world: 'w', generation: 6, scanSequence: 1, previous: { alpha: { attackCount: 0, raidCount: 0 } }, current: { alpha: { attackCount: 2, raidCount: 0 } } });
    const b = conservation.assignPositiveNetDeltas({ world: 'w', generation: 7, scanSequence: 2, previous: { alpha: { attackCount: 2, raidCount: 0 } }, current: { alpha: { attackCount: 5, raidCount: 0 } } });
    const merged = conservation.coalesceSourceIds([{ sourceEventIds: a }, { sourceEventIds: b }]);
    assert.deepEqual(merged, [...a, ...b]);
});

test('conservation incident accounting: frozen incident golden reports parsed attack sum two', () => {
    assert.equal(acquisition.readGoldenContracts()['members-59-incident'].attackSum, 2);
});

test('conservation delivery: forced splits are projections, never extra summands', () => {
    const sources = conservation.assignPositiveNetDeltas({ world: 'w', generation: 10, scanSequence: 1, previous: { alpha: { attackCount: 0, raidCount: 0 } }, current: { alpha: { attackCount: 4, raidCount: 0 } } });
    conservation.assertConservation({ detections: [{ sourceEventIds: sources, disposition: 'eligible' }], delivery: { entries: [{ stage: 'prepared', sourceEventIds: sources.slice(0, 2) }, { stage: 'sending', sourceEventIds: sources.slice(2) }], compactedTerminalTotals: [] }, queueProjection: sources.slice(0, 2), dispatchProjection: sources.slice(2) });
    assert.throws(() => conservation.assertConservation({ detections: [{ sourceEventIds: sources, disposition: 'eligible' }], delivery: { entries: [{ stage: 'prepared', sourceEventIds: sources }], compactedTerminalTotals: [] }, queueProjection: ['projection-only'] }), /not in delivery accounting/i);
});

test('conservation detection: threshold-blocked and muted sources never enter delivery', () => {
    const sources = conservation.assignPositiveNetDeltas({ world: 'w', generation: 11, scanSequence: 1, previous: { alpha: { attackCount: 0, raidCount: 0 } }, current: { alpha: { attackCount: 3, raidCount: 1 } } });
    conservation.assertConservation({ detections: [{ sourceEventIds: sources.slice(0, 1), disposition: 'muted' }, { sourceEventIds: sources.slice(1, 3), disposition: 'threshold-blocked' }, { sourceEventIds: sources.slice(3), disposition: 'eligible' }], delivery: { entries: [{ stage: 'retryable', sourceEventIds: sources.slice(3) }], compactedTerminalTotals: [] } });
});

test('conservation delivery: 513 terminal entries, splits, and retries conserve once', () => {
    const sources = conservation.assignPositiveNetDeltas({ world: 'w', generation: 8, scanSequence: 1, previous: { alpha: { attackCount: 0, raidCount: 0 } }, current: { alpha: { attackCount: 513, raidCount: 0 } } });
    const entries = sources.slice(1).map((sourceEventId, index) => ({ stage: index < 19 ? 'sending' : index < 39 ? 'failed' : index % 2 ? 'acknowledged' : 'retryable', sourceEventIds: [sourceEventId] }));
    conservation.assertConservation({ detections: [{ sourceEventIds: sources, disposition: 'eligible' }], delivery: { entries, compactedTerminalTotals: [{ from: 1, to: 1, count: 1, sourceEventIds: sources.slice(0, 1) }] } });
});

test('conservation negative: dropped, duplicate, wrong-count, and corrupt coalescer report deterministic diagnostics', () => {
    const sources = conservation.assignPositiveNetDeltas({ world: 'w', generation: 9, scanSequence: 1, previous: { alpha: { attackCount: 0, raidCount: 0 } }, current: { alpha: { attackCount: 3, raidCount: 0 } } });
    const base = { detections: [{ sourceEventIds: sources, disposition: 'eligible' }] };
    assert.throws(() => conservation.assertConservation({ ...base, delivery: { entries: [{ stage: 'pending', sourceEventIds: sources.slice(1) }], compactedTerminalTotals: [] } }), /missing source ID.*stage pending/i);
    assert.throws(() => conservation.assertConservation({ ...base, delivery: { entries: [{ stage: 'pending', sourceEventIds: [...sources, sources[0]] }], compactedTerminalTotals: [] } }), /duplicate source ID.*stage pending/i);
    assert.throws(() => conservation.assertConservation({ detections: [{ sourceEventIds: sources.slice(0, 2), disposition: 'eligible' }], delivery: { positiveNetDelta: sources.length, entries: [{ stage: 'pending', sourceEventIds: sources.slice(0, 2) }], compactedTerminalTotals: [] } }), /wrong count/i);
    assert.throws(() => conservation.assertConservation({ ...base, delivery: { entries: [{ stage: 'pending', sourceEventIds: conservation.coalesceSourceIds([{ sourceEventIds: sources }, { sourceEventIds: [sources[0]] }]) }], compactedTerminalTotals: [] } }), /duplicate source ID/i);
});

test('Todo 5 accepted scan planner closes every delta with muted precedence', () => {
    const snapshot = makeMonitorSnapshot({ '101': makeMonitorMember('101', 'Alpha', 8, 0) });
    const plan = script.planAcceptedScanTransition(
        snapshot, {}, new Set(['101']), 3, 0,
        { ownerId: 'owner-a', term: 7 }, { world: HOST }
    );
    assert.equal(plan.baselineByPlayerId['101'].attackCount, 8);
    assert.equal(plan.detections[0].disposition, 'muted');
    assert.equal(plan.eligibleEvents.length, 0);
    assert.equal(plan.detections[0].sourceEventIds.length, 8);
});

test('Todo 5 accepted scan commit writes baseline and eligible queue in one generation', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, { generation: 0 });
    storage.values.set(script.monitorActiveStorageKey(HOST), script.serializeMonitorEnvelopeV1(old));
    storage.values.set(script.monitorBackupStorageKey(HOST), script.serializeMonitorEnvelopeV1(old));
    const plan = script.planAcceptedScanTransition(
        makeMonitorSnapshot({ '101': makeMonitorMember('101', 'Alpha', 8, 0) }),
        {}, new Set(), 1, 0, { ownerId: 'owner-a', term: 7 }, { world: HOST }
    );
    const result = script.commitMonitorEnvelope({
        world: HOST, currentEnvelope: old, transition: plan, storage,
        expectedGeneration: 0, ownerId: 'owner-a', term: 7,
        currentFence: () => ({ ownerId: 'owner-a', term: 7, generation: 0 })
    });
    assert.equal(result.outcome, 'ok');
    assert.equal(result.envelope.generation, 1);
    assert.equal(Object.keys(result.envelope.baselineByPlayerId).length, 1);
    assert.equal(result.envelope.pending.length, 1);
    assert.equal(result.envelope.pending[0].sourceEventIds.length, 8);
});

test('monitor commit-attempt hook reports the attempted transition generation without unbound references', () => {
    const plan = script.planAcceptedScanTransition(
        makeMonitorSnapshot({ '101': makeMonitorMember('101', 'Alpha', 2, 1) }),
        {}, new Set(), 1, 7, { ownerId: 'o', term: 1 }, { world: HOST }
    );
    assert.equal(plan.outcome, 'ok');
    assert.equal(plan.generation, 8);
    const scriptSource = fs.readFileSync(require.resolve('../script.txt'), 'utf8');
    assert.match(scriptSource, /reportLifecycleHook\("onMonitorCommitAttempt", \{\s+observedAtMs,\s+generation: transition\.generation\s+\}\)/);
    assert.equal(/\bcandidate\b/.test(scriptSource), false);
});

test('Todo 5 failed monitor storage restores active and backup bytes', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, { generation: 2 });
    const activeKey = script.monitorActiveStorageKey(HOST);
    const backupKey = script.monitorBackupStorageKey(HOST);
    storage.values.set(activeKey, script.serializeMonitorEnvelopeV1(old));
    storage.values.set(backupKey, script.serializeMonitorEnvelopeV1(old));
    const before = new Map(storage.values);
    storage.set = (key, value) => { if (key === activeKey) throw new Error('quota'); storage.values.set(key, value); };
    const plan = script.planAcceptedScanTransition(makeMonitorSnapshot({ '101': makeMonitorMember('101', 'A', 1, 0) }), {}, new Set(), 1, 2, { ownerId: 'o', term: 1 }, { world: HOST });
    const result = script.commitMonitorEnvelope({ world: HOST, currentEnvelope: old, transition: plan, storage, expectedGeneration: 2, ownerId: 'o', term: 1 });
    assert.notEqual(result.outcome, 'ok');
    assert.deepEqual(storage.values, before);
});

test('Todo 5 stale term and capacity reject before durable baseline advance', () => {
    const storage = makeMonitorMemory();
    const old = script.createMonitorEnvelopeV1(HOST, { generation: 4 });
    storage.values.set(script.monitorActiveStorageKey(HOST), script.serializeMonitorEnvelopeV1(old));
    storage.values.set(script.monitorBackupStorageKey(HOST), script.serializeMonitorEnvelopeV1(old));
    const plan = script.planAcceptedScanTransition(makeMonitorSnapshot({ '101': makeMonitorMember('101', 'A', 1, 0) }), {}, new Set(), 1, 4, { ownerId: 'o', term: 9 }, { world: HOST });
    const stale = script.commitMonitorEnvelope({ world: HOST, currentEnvelope: old, transition: plan, storage, expectedGeneration: 4, ownerId: 'o', term: 9, currentFence: () => ({ ownerId: 'o', term: 8, generation: 4 }) });
    assert.equal(stale.outcome, 'fenced-reject');
    const quota = script.commitMonitorEnvelope({ world: HOST, currentEnvelope: old, transition: plan, storage, expectedGeneration: 4, ownerId: 'o', term: 9, queueCapacity: 0 });
    assert.equal(quota.outcome, 'capacity-reject');
});

test('Todo 6 injective normal identity round-trips and rejects malformed IDs', () => {
    const tuple = { world: 'w-é', playerId: '101', eventType: 'attack', acceptedGeneration: 4, scanSequence: 9, attackDelta: 2, raidDelta: 0 };
    const id = script.sourceEventIdFromTuple(tuple);
    assert.match(id, /^s1:[A-Za-z0-9_-]+$/);
    assert.deepEqual(script.decodeSourceEventId(id), tuple);
    assert.equal(script.sourceEventIdFromTuple(tuple), id);
    assert.notEqual(script.sourceEventIdFromTuple({ ...tuple, scanSequence: 10 }), id);
    assert.throws(() => script.decodeSourceEventId(`${id}A`), /malformed|noncanonical|round-trip/i);
});

test('Todo 6 coalesce sourceEventIds unions lineage and sums deltas without replacing IDs', () => {
    const make = scanSequence => script.createMonitorQueueEvent({
        world: 'w', playerId: '101', eventType: 'attack', addedAttackCount: 2,
        addedRaidCount: 0, sourceEventIds: [script.sourceEventIdFromTuple({ world: 'w', playerId: '101', eventType: 'attack', acceptedGeneration: 1, scanSequence, attackDelta: scanSequence, raidDelta: 0 })]
    });
    const left = make(1);
    const right = make(2);
    const result = script.coalesceMonitorPendingEvents([left, right]);
    assert.equal(result.ok, true);
    assert.equal(result.events[0].addedAttackCount, 4);
    assert.deepEqual(result.events[0].sourceEventIds, [...left.sourceEventIds, ...right.sourceEventIds]);
});

test('Todo 6 terminal compaction conservation: 513 acknowledged entries compact exactly once', () => {
    const entries = Array.from({ length: 513 }, (_, index) => ({
        eventId: `e-${index}`, world: 'w', playerId: String(index), eventType: 'attack',
        addedAttackCount: 1, sourceEventIds: [script.sourceEventIdFromTuple({ world: 'w', playerId: String(index), eventType: 'attack', acceptedGeneration: 1, scanSequence: index, attackDelta: 1, raidDelta: 0 })], terminalSequence: index + 1, stage: 'acknowledged'
    }));
    const base = script.createMonitorEnvelopeV1('w', { generation: 7, metrics: { deliveryAccounting: { terminal: entries, recoverable: [], compactedTerminalTotals: [], nextTerminalSequence: 514 } } });
    const prepared = script.prepareTerminalCompactionV1(base, { operationId: 'op-1', ownerId: 'owner', leaseTerm: 3 });
    assert.equal(prepared.outcome, 'prepared');
    assert.equal(prepared.envelope.metrics.deliveryAccounting.compactionClaim.status, 'prepared');
    const folded = script.resumeTerminalCompactionV1(prepared.envelope);
    assert.equal(folded.outcome, 'compacted');
    assert.equal(folded.envelope.metrics.deliveryAccounting.terminal.length, 512);
    assert.equal(folded.envelope.metrics.deliveryAccounting.compactedTerminalTotals[0].count, 1);
    assert.equal(script.resumeTerminalCompactionV1(folded.envelope).outcome, 'nothing-to-compact');
});

test('Todo 6 legacy active lineage envelopes remain loadable and diagnostics are outside accounting', () => {
    const old = script.createMonitorEnvelopeV1('w', { metrics: { lastError: null } });
    delete old.metrics.deliveryAccounting;
    old.integrity = script.checksumMonitorCanonicalValue(Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'integrity')));
    const parsed = script.parseMonitorEnvelopeV1(old, 'w');
    assert.equal(parsed.ok, true);
    const accounting = script.createMonitorEnvelopeV1('w').metrics.deliveryAccounting;
    const before = JSON.stringify(accounting);
    script.saveDiagnostics({ w: { forbidden: { toJSON() { throw new Error('diagnostic'); } } } });
    assert.equal(JSON.stringify(accounting), before);
});

test('Todo 8 legacy identities are injective and round-trip canonical active fields', () => {
    const event = { name: 'A', url: '/profile/1', attackCount: 3, raidCount: 2, oldAttackCount: 2, oldRaidCount: 1, addedAttackCount: 1, addedRaidCount: 1, eventType: 'mixed', observedAtMs: 10, queuedAtMs: 11, attemptCount: 0, responseClass: null, eventId: 'raw' };
    const first = script.canonicalizeLegacyActiveEvent(event, { world: HOST, sourceStore: 'pending', originalIndex: 0 });
    const second = script.canonicalizeLegacyActiveEvent(event, { world: HOST, sourceStore: 'pending', originalIndex: 1, legacyEventId: 'raw' });
    assert.match(first.eventId, /^ls1:/);
    assert.notEqual(first.eventId, second.eventId);
    assert.deepEqual(script.decodeLegacyIdentity(first.eventId), first.legacyIdentity);
    assert.deepEqual(first.canonicalEventFields, second.canonicalEventFields);
    assert.equal(first.rawEventId, 'raw');
});

test('Todo 8 history-only records carry lh1 unknown provenance outside delivery', () => {
    const plan = script.planMonitorLegacyMigration({ history: { events: [{ name: 'A', url: '/profile/1', attackCount: 4, raidCount: 1, eventType: 'attack' }] } }, null, HOST);
    assert.match(plan.history[0].recordIdentity, /^lh1:/);
    assert.equal(plan.history[0].deliveryState, 'unknown-legacy');
    assert.equal(plan.pending.length, 0);
    assert.equal(plan.failed.length, 0);
});

test('Todo 8 old-script queue removal is uncertain and cannot acknowledge history', () => {
    const plan = script.planMonitorLegacyMigration({ removed: { events: [{ name: 'A', url: '/profile/1', addedAttackCount: 1, eventType: 'attack', eventId: 'x' }] } }, null, HOST);
    assert.equal(plan.uncertain[0].responseClass, 'uncertain-legacy-settlement');
    assert.equal(plan.uncertain[0].deliveryState, 'uncertain-legacy-settlement');
    assert.throws(() => script.decodeLegacyIdentity('ls1:AAAA'), /malformed|invalid|non-round/);
});

test('Todo 8 identity validation rejects malformed canonical fields and non-round trips', () => {
    const event = script.canonicalizeLegacyActiveEvent({ name: 'A', url: '/a', eventType: 'attack' }, { world: HOST, sourceStore: 'failed', originalIndex: 2 });
    const decoded = script.decodeLegacyIdentity(event.eventId);
    assert.throws(() => script.canonicalizeLegacyActiveEvent({ ...event, canonicalEventFields: { ...decoded.canonicalEventFields, extra: true } }, { world: HOST, sourceStore: 'failed', originalIndex: 2 }), /malformed canonical fields/);
    assert.throws(() => script.decodeLegacyIdentity(`${event.eventId}A`), /malformed|noncanonical|round-tripping/);
});

test('Todo 9 canonical diagnostics serializer applies stable Unicode and JSON rules', () => {
    assert.equal(script.canonicalSerializeDiagnostics({ b: 'x', a: '\uD800e\u0301' }), '{"a":"�é","b":"x"}');
    assert.equal(script.canonicalSerializeDiagnostics({ astral: '😀'.repeat(400) }).length, JSON.stringify({ astral: '😀'.repeat(320) }).length);
    assert.equal(script.canonicalSerializeDiagnostics({ z: -0, n: Infinity, a: [undefined, NaN, 2] }), '{"a":[null,null,2],"n":null,"z":0}');
});

test('Todo 9 rejects normalized key collisions and cycles', () => {
    assert.throws(() => script.canonicalSerializeDiagnostics({ 'e\u0301': 1, é: 2 }), /duplicate/i);
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => script.canonicalSerializeDiagnostics(cycle), /cycle/i);
});

test('Todo 9 retains newest 256 traces and emits bounded fallbacks', () => {
    let world = script.createDiagnosticsWorldV2('world.example');
    for (let sequence = 1; sequence <= 300; sequence += 1) {
        world = script.appendDiagnosticTraceV2(world, { stage: 'route', status: 'ok', sequence });
    }
    assert.equal(world.records.length, 256);
    assert.equal(world.records[0].sequence, 45);
    assert.equal(world.records.at(-1).sequence, 300);
    const consolePayload = script.serializeDiagnosticsConsoleV2({ sequence: 1, stage: 'route', records: [{ reason: 'x'.repeat(10000) }] });
    const exportPayload = script.serializeDiagnosticsExportV2('world.example', { records: [{ reason: 'x'.repeat(1000000) }] });
    assert.ok(Buffer.byteLength(consolePayload) <= 2048);
    assert.ok(Buffer.byteLength(exportPayload) <= 512 * 1024);
});

test('Todo 8 migration is one-shot and keeps baseline, accounting, and schema keys', () => {
    const storage = makeMonitorMemory();
    const first = script.loadOrMigrateMonitorEnvelopeV1(HOST, makeMonitorSnapshot({ '1': makeMonitorMember('1', 'A', 4, 2) }), {
        storage, nowMs: 20, legacy: { pending: { events: [{ id: '1', addedAttackCount: 1, eventType: 'attack' }] }, history: { events: [{ name: 'A' }] } }
    });
    const second = script.loadOrMigrateMonitorEnvelopeV1(HOST, null, { storage, legacy: { pending: { events: [{ id: 'wrong' }] } } });
    assert.equal(first.envelope.schemaVersion, 1);
    assert.equal(second.outcome, 'ok');
    assert.equal(second.envelope.pending[0].eventId, first.envelope.pending[0].eventId);
    assert.deepEqual(second.envelope.metrics.deliveryAccounting, first.envelope.metrics.deliveryAccounting);
    assert.equal(script.monitorActiveStorageKey(HOST), 'travianAllianceMonitor_v1:cw.x2.international.travian.com');
});
