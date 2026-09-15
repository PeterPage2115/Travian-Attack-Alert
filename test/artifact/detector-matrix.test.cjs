'use strict';

/*
 * Detector behavior matrix for public release 1.0.0 (plan Todo 7).
 *
 * Loads the BUILT ARTIFACT (dist/travian-attack-alert.user.js, 1.0.0 bytes)
 * via the same require mechanism the suite uses for the src runtime — dist is the
 * byte-identical committed copy of the runtime authority (see the
 * 'artifact authority' test below), so every assertion below locks shipped
 * behavior, not src/ shim behavior.
 *
 * Synthetic fixtures only: playerId '101'/'102'/'103', hostnames
 * *.example.travian.com. No DEV backup bytes, no real hosts, no network.
 *
 * Run: node --test test/artifact/detector-matrix.test.cjs
 * Gate: npm run check:release -- --offline (artifact-matrix gate).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_FILE = path.join(ROOT, 'dist', 'travian-attack-alert.user.js');
const DIST_SIDECAR = `${DIST_FILE}.sha256`;
const RUNTIME_FILE = path.join(ROOT, 'src', 'runtime.js');

const runtime = require(DIST_FILE);

const WORLD_A = 's1.example.travian.com';
const WORLD_B = 's2.example.travian.com';
const T0 = 1700000000000;

// ---------------------------------------------------------------------------
// Fixture builders (synthetic, mirror the suite's Todo 2 / Todo 5 shapes).
// ---------------------------------------------------------------------------

function row(id, name, icons = []) {
    return { id, name, url: `/profile/${id}`, icons };
}

function icon(tooltip, extra = {}) {
    return Object.assign({ className: 'attack', tooltipSources: [tooltip] }, extra);
}

function member(attackCount = 0, raidCount = 0, name = 'Alpha') {
    return { name, url: '/profile/101', attackCount, raidCount };
}

function snapshot(membersById, observedAtMs = T0) {
    return {
        status: 'authoritative',
        observedAtMs,
        tableSignature: 'alliance-members-v1:detector-matrix',
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

function domNode({ text = '', attributes = {}, className = '', rows = [], links = [], images = [] } = {}) {
    const node = {
        textContent: text,
        className,
        parentElement: null,
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
        querySelectorAll(selector) {
            if (selector === 'tr') return rows;
            if (selector === 'a') return links;
            if (selector === 'img') return images;
            if (selector === 'table') return [];
            return [];
        }
    };
    node.classList = { contains: name => String(className).split(/\s+/).includes(name) };
    return node;
}

function domLink(id, name) {
    return domNode({ text: name, attributes: { href: `/profile/${id}` } });
}

function domMemberRow(id, name, tooltip) {
    const link = domLink(id, name);
    const image = domNode({ className: 'attack', attributes: { 'data-tooltip': tooltip } });
    const result = domNode({ links: [link], images: [image] });
    image.parentElement = result;
    return result;
}

function memberTable(rows, attributes = {}) {
    const table = domNode({ rows, links: rows.flatMap(r => r.querySelectorAll('a')) });
    table.className = 'allianceMembers';
    table.getAttribute = name => Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : name === 'class' ? 'allianceMembers' : null;
    return table;
}

function docWithTables(tables) {
    return { querySelectorAll: selector => (selector === 'table' ? tables : []) };
}

function memoryStorage() {
    const values = new Map();
    return {
        values,
        get(key) { return values.has(key) ? values.get(key) : undefined; },
        set(key, value) { values.set(key, value); }
    };
}

function seededEnvelope(world, generation = 0) {
    const storage = memoryStorage();
    const envelope = runtime.createMonitorEnvelopeV1(world, { generation });
    storage.set(runtime.monitorActiveStorageKey(world), runtime.serializeMonitorEnvelopeV1(envelope));
    storage.set(runtime.monitorBackupStorageKey(world), runtime.serializeMonitorEnvelopeV1(envelope));
    return { storage, envelope };
}

function storageBytes(storage) {
    return JSON.stringify([...storage.values.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// Artifact authority.
// ---------------------------------------------------------------------------

test('artifact authority: dist is the generated 1.0.0 installable', () => {
    const distBytes = fs.readFileSync(DIST_FILE);
    const digest = crypto.createHash('sha256').update(distBytes).digest('hex');
    const sidecar = fs.readFileSync(DIST_SIDECAR, 'utf8').trim();
    assert.equal(sidecar, `${digest}  dist/travian-attack-alert.user.js`);
    assert.match(distBytes.toString('utf8'), /^\/\/ @version\s+1\.0\.0$/m);
    assert.ok(distBytes.includes('const RELEASE_ID = "taa-1.0.0"'));
    assert.deepEqual(Object.keys(runtime).sort(), Object.keys(require(RUNTIME_FILE)).sort());
});

// ---------------------------------------------------------------------------
// Delta matrix: buildAllianceSnapshot + diffAllianceSnapshots.
// ---------------------------------------------------------------------------

test('matrix: zero attacks — establishment scan emits nothing but commits', () => {
    const zero = runtime.buildAllianceSnapshot({ rows: [row('101', 'Alpha', [])] }, T0);
    assert.equal(zero.status, 'authoritative');
    assert.deepEqual([zero.membersById['101'].attackCount, zero.membersById['101'].raidCount], [0, 0]);
    const diff = runtime.diffAllianceSnapshots(null, zero);
    assert.equal(diff.commit, true);
    assert.deepEqual(diff.events, []);
    // An unparseable zero-count icon fails closed instead of establishing.
    const malformedZero = runtime.buildAllianceSnapshot(
        { rows: [row('101', 'Alpha', [icon('no attacks')])] }, T0
    );
    assert.equal(malformedZero.status, 'invalid');
    assert.equal(malformedZero.anomalies.malformedCount, true);
});

test('matrix: +attack delta emits exactly the positive delta', () => {
    const previous = snapshot({ '101': member(0, 0) });
    const current = snapshot({ '101': member(2, 0) });
    const diff = runtime.diffAllianceSnapshots(previous, current);
    assert.equal(diff.commit, true);
    assert.equal(diff.events.length, 1);
    assert.deepEqual(
        { type: diff.events[0].eventType, added: diff.events[0].addedAttackCount, raids: diff.events[0].addedRaidCount },
        { type: 'attack', added: 2, raids: 0 }
    );
});

test('matrix: raid-only delta emits a raid event', () => {
    const diff = runtime.diffAllianceSnapshots(snapshot({ '101': member(0, 0) }), snapshot({ '101': member(0, 1) }));
    assert.equal(diff.commit, true);
    assert.equal(diff.events.length, 1);
    assert.equal(diff.events[0].eventType, 'raid');
    assert.equal(diff.events[0].addedRaidCount, 1);
    assert.equal(diff.events[0].addedAttackCount, 0);
});

test('matrix: mixed deltas — one mixed event per player, one event per delta player', () => {
    const previous = snapshot({ '101': member(1, 0), '102': member(0, 0) });
    const current = snapshot({ '101': member(2, 1), '102': member(0, 1) });
    const diff = runtime.diffAllianceSnapshots(previous, current);
    assert.equal(diff.commit, true);
    assert.equal(diff.events.length, 2);
    const byId = Object.fromEntries(diff.events.map(e => [e.id, e]));
    assert.equal(byId['101'].eventType, 'mixed');
    assert.deepEqual([byId['101'].addedAttackCount, byId['101'].addedRaidCount], [1, 1]);
    assert.equal(byId['102'].eventType, 'raid');
});

test('matrix: counter drop emits NOTHING and does not rebaseline to a negative', () => {
    const previous = snapshot({ '101': member(5, 3) });
    const current = snapshot({ '101': member(2, 1) });
    const diff = runtime.diffAllianceSnapshots(previous, current);
    assert.equal(diff.commit, true);
    assert.deepEqual(diff.events, []);
    for (const event of diff.events) {
        assert.ok(event.addedAttackCount >= 0 && event.addedRaidCount >= 0);
    }
});

test('matrix: disappear emits no phantom attack; unchanged scan commits nothing new', () => {
    const full = snapshot({ '101': member(3, 1) });
    const gone = runtime.diffAllianceSnapshots(full, snapshot({}));
    assert.equal(gone.commit, true);
    assert.deepEqual(gone.events, []);
    assert.deepEqual(gone.current, {});
    const same = runtime.diffAllianceSnapshots(full, snapshot({ '101': member(3, 1) }));
    assert.equal(same.commit, true);
    assert.deepEqual(same.events, []);
});

test('matrix: planner emits exactly the positive net delta with stable source IDs', () => {
    const plan = runtime.planAcceptedScanTransition(
        snapshot({ '101': member(2, 1) }), { '101': member(0, 0) },
        new Set(), 1, 0, { ownerId: 'owner-a', term: 7 }, { world: WORLD_A }
    );
    assert.equal(plan.outcome, 'ok');
    assert.equal(plan.detections.length, 1);
    assert.equal(plan.detections[0].eventType, 'mixed');
    assert.equal(plan.detections[0].disposition, 'eligible');
    // 2 attack + 1 raid net delta => exactly 3 source IDs, one per delta unit.
    assert.equal(plan.detections[0].sourceEventIds.length, 3);
    assert.equal(plan.eligibleEvents.length, 1);
    assert.equal(plan.baselineByPlayerId['101'].attackCount, 2);
});

test('matrix: planner drops counters and identical scans to zero detections', () => {
    const dropped = runtime.planAcceptedScanTransition(
        snapshot({ '101': member(1, 0) }), { '101': member(4, 2) },
        new Set(), 1, 3, { ownerId: 'o', term: 1 }, { world: WORLD_A }
    );
    assert.equal(dropped.outcome, 'ok');
    assert.deepEqual(dropped.detections, []);
    assert.deepEqual(dropped.eligibleEvents, []);
    // Baseline still advances to the observed (lower) counts.
    assert.equal(dropped.baselineByPlayerId['101'].attackCount, 1);
    const identical = runtime.planAcceptedScanTransition(
        snapshot({ '101': member(4, 2) }), { '101': member(4, 2) },
        new Set(), 1, 4, { ownerId: 'o', term: 1 }, { world: WORLD_A }
    );
    assert.deepEqual(identical.detections, []);
    assert.deepEqual(identical.eligibleEvents, []);
});

// ---------------------------------------------------------------------------
// Roster matrix: join / leave classification (diffRoster + leave record shape).
// ---------------------------------------------------------------------------

test('matrix: disappear is a leave, reappear is a join — never a diff phantom', () => {
    const alive = { '101': member(3, 0) };
    const left = runtime.diffRoster(alive, {});
    assert.deepEqual(left.joined, []);
    assert.equal(left.left.length, 1);
    assert.equal(left.left[0].id, '101');
    assert.equal(left.changed, true);
    const joined = runtime.diffRoster({}, alive);
    assert.deepEqual(joined.left, []);
    assert.equal(joined.joined.length, 1);
    assert.equal(joined.joined[0].id, '101');
    const steady = runtime.diffRoster(alive, alive);
    assert.equal(steady.changed, false);
});

test('matrix: leave record carries zero counts with eventType leave', () => {
    // Mirrors the toRosterEvent lambda wired in the runtime authority: roster
    // join/leave records are zero-count markers, never attack/raid deltas.
    const toRosterEvent = (m, type) => ({
        playerId: String(m.id),
        name: m.name,
        url: m.url,
        attackCount: 0,
        raidCount: 0,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 0,
        addedRaidCount: 0,
        eventType: type
    });
    const leave = toRosterEvent({ id: '101', name: 'Alpha', url: '/profile/101' }, 'leave');
    assert.equal(leave.eventType, 'leave');
    assert.deepEqual(
        [leave.attackCount, leave.raidCount, leave.addedAttackCount, leave.addedRaidCount],
        [0, 0, 0, 0]
    );
    const diff = runtime.diffRoster({ '101': member(3, 1) }, {});
    assert.equal(diff.left.length, 1);
    const join = toRosterEvent({ id: '101', name: 'Alpha', url: '/profile/101' }, 'join');
    assert.equal(join.eventType, 'join');
});

test('matrix: reappear-after-absence is join at roster level; planner nets the visible delta (AUDIT L-01)', () => {
    // Net-based sampling (DESIGN §9): the accepted snapshot after an absence
    // carries no previous counts, so the visible count is a positive net
    // delta. The roster join record stays the membership signal. Locked as-is;
    // see docs/AUDIT.md limitation L-01 — must NOT be "fixed" into a miss.
    const roster = runtime.diffRoster({}, { '101': member(3, 0) });
    assert.equal(roster.joined.length, 1);
    const plan = runtime.planAcceptedScanTransition(
        snapshot({ '101': member(3, 0) }), {},
        new Set(), 1, 7, { ownerId: 'o', term: 1 }, { world: WORLD_A }
    );
    assert.equal(plan.detections.length, 1);
    assert.equal(plan.detections[0].addedAttackCount, 3);
});

// ---------------------------------------------------------------------------
// Rejection matrix: exact reason codes, zero alerts, byte-identical baseline.
// ---------------------------------------------------------------------------

test('matrix: table selection rejects with the exact documented reason codes', () => {
    const good = memberTable([domMemberRow('101', 'Alpha', '2 attacks')]);
    const cases = [
        ['no-member-table', docWithTables([])],
        ['multiple-member-tables', docWithTables([good, good])],
        ['pagination-or-filter', docWithTables([memberTable([domMemberRow('101', 'Alpha', '2 attacks')], { 'data-pagination': 'true' })])],
        ['missing-player-id', docWithTables([memberTable([domNode({ images: [domNode({ className: 'attack', attributes: { title: '1 attack' } })] })])])],
        ['duplicate-player-id', docWithTables([memberTable([domMemberRow('101', 'Alpha', '1 attack'), domMemberRow('101', 'Beta', '2 attacks')])])],
        ['conflicting-tooltip', docWithTables([(() => {
            const table = memberTable([domMemberRow('101', 'Alpha', '1 attack')]);
            const iconNode = table.querySelectorAll('tr')[0].querySelectorAll('img')[0];
            iconNode.getAttribute = name => (name === 'data-tooltip' ? '1 attack' : name === 'title' ? '2 attacks' : null);
            return table;
        })()])],
        ['malformed-count', docWithTables([memberTable([domMemberRow('101', 'Alpha', 'zero attacks')])])]
    ];
    assert.equal(cases.length, 7);
    for (const [reason, doc] of cases) {
        const result = runtime.parseMemberSnapshot(doc, T0);
        assert.equal(result.status, 'rejected', reason);
        assert.equal(result.reason, reason, reason);
        assert.deepEqual(result.membersById, {}, reason);
    }
});

test('matrix: row-level duplicate / partial / empty tables fail closed', () => {
    const duplicate = runtime.buildAllianceSnapshot({ rows: [
        row('101', 'Alpha', [icon('1 attack')]),
        row('101', 'RenamedConflict', [icon('4 attacks')])
    ] }, T0);
    assert.equal(duplicate.status, 'invalid');
    assert.equal(duplicate.anomalies.duplicateId, true);
    const partial = runtime.buildAllianceSnapshot(
        { rows: [row('101', 'Alpha', [icon('5 attacks')])], paginationOrFilter: true }, T0
    );
    assert.equal(partial.status, 'partial');
    const empty = runtime.buildAllianceSnapshot({ rows: [] }, T0);
    assert.equal(empty.status, 'invalid');
    for (const bad of [duplicate, partial, empty]) {
        assert.deepEqual(runtime.diffAllianceSnapshots(snapshot({ '101': member(9, 9) }), bad).events, []);
        assert.equal(runtime.diffAllianceSnapshots(snapshot({ '101': member(9, 9) }), bad).commit, false);
    }
});

test('matrix: every rejected scan leaves the authoritative baseline byte-identical', () => {
    const { storage, envelope } = seededEnvelope(WORLD_A, 2);
    const before = storageBytes(storage);
    const baselineBefore = runtime.serializeMonitorEnvelopeV1(envelope);
    const rejectedReasons = [
        { status: 'rejected', reason: 'duplicate-player-id', membersById: {}, observedAtMs: T0 },
        { status: 'rejected', reason: 'malformed-count', membersById: {}, observedAtMs: T0 },
        { status: 'invalid', membersById: {}, observedAtMs: T0 },
        { status: 'partial', membersById: { '101': member(9, 9) }, observedAtMs: T0 }
    ];
    for (const rejected of rejectedReasons) {
        const plan = runtime.planAcceptedScanTransition(
            rejected, envelope.baselineByPlayerId, new Set(), 1, 2,
            { ownerId: 'o', term: 1 }, { world: WORLD_A }
        );
        assert.equal(plan.outcome, 'invalid-snapshot', rejected.reason || rejected.status);
        assert.deepEqual(plan.detections, []);
        assert.deepEqual(plan.eligibleEvents, []);
        const result = runtime.commitMonitorEnvelope({
            world: WORLD_A, currentEnvelope: envelope, transition: plan, storage,
            expectedGeneration: 2, ownerId: 'o', term: 1,
            currentFence: () => ({ ownerId: 'o', term: 1, generation: 2 })
        });
        assert.equal(result.outcome, 'invalid-transition');
        assert.equal(result.memorySwapped, false);
    }
    assert.equal(storageBytes(storage), before, 'storage bytes must be identical after all rejected scans');
    assert.equal(
        runtime.serializeMonitorEnvelopeV1(
            runtime.parseMonitorEnvelopeV1(storage.get(runtime.monitorActiveStorageKey(WORLD_A))).envelope
        ),
        baselineBefore,
        'active baseline bytes must be identical after all rejected scans'
    );
});

// ---------------------------------------------------------------------------
// Isolation matrix: per-hostname baselines.
// ---------------------------------------------------------------------------

test('matrix: two world hostnames keep isolated baselines', () => {
    const a = seededEnvelope(WORLD_A, 0);
    const b = seededEnvelope(WORLD_B, 0);
    const shared = memoryStorage();
    for (const [key, value] of [...a.storage.values, ...b.storage.values]) shared.set(key, value);
    assert.notEqual(
        runtime.monitorActiveStorageKey(WORLD_A),
        runtime.monitorActiveStorageKey(WORLD_B)
    );
    const planA = runtime.planAcceptedScanTransition(
        snapshot({ '101': member(2, 0) }), {}, new Set(), 1, 0,
        { ownerId: 'o', term: 1 }, { world: WORLD_A }
    );
    const committed = runtime.commitMonitorEnvelope({
        world: WORLD_A, currentEnvelope: a.envelope, transition: planA, storage: shared,
        expectedGeneration: 0, ownerId: 'o', term: 1,
        currentFence: () => ({ ownerId: 'o', term: 1, generation: 0 })
    });
    assert.equal(committed.outcome, 'ok');
    const liveB = runtime.parseMonitorEnvelopeV1(shared.get(runtime.monitorActiveStorageKey(WORLD_B)));
    assert.equal(liveB.ok, true);
    assert.deepEqual(liveB.envelope.baselineByPlayerId, {}, 'world B baseline is untouched by world A commit');
    assert.equal(liveB.envelope.generation, 0);
    const liveA = runtime.parseMonitorEnvelopeV1(shared.get(runtime.monitorActiveStorageKey(WORLD_A)));
    assert.equal(liveA.envelope.baselineByPlayerId['101'].attackCount, 2);
});

// ---------------------------------------------------------------------------
// Bound matrix: one accepted scan exceeding the queue bound.
// ---------------------------------------------------------------------------

test('matrix: single accepted scan over the queue bound keeps the bound and reports overflow', () => {
    const limit = runtime.QUEUE_MAX_EVENTS;
    assert.ok(Number.isInteger(limit) && limit > 0, 'queue bound must be a positive integer');
    const events = Array.from({ length: limit + 10 }, (_, index) => ({
        playerId: '101',
        name: `Player ${index}`,
        url: '/profile/101',
        attackCount: 1,
        raidCount: 0,
        oldAttackCount: 0,
        oldRaidCount: 0,
        addedAttackCount: 1,
        addedRaidCount: 0,
        eventType: 'attack'
    }));
    const batch = runtime.enqueueEvents({}, WORLD_A, events);
    const worldKey = Object.keys(batch)[0];
    const world = batch[worldKey];
    assert.equal(world.events.length, limit, 'queue keeps exactly the bound');
    assert.equal(world.overflowCount, 10, 'overflow is counted, not silently dropped');
    assert.equal(world.overflowReason, 'queue-cap');
    assert.match(world.overflowMessage, /bounded/i);
    // Newest events survive; oldest are omitted first.
    assert.equal(world.events[world.events.length - 1].name, `Player ${limit + 9}`);
    assert.equal(world.events[0].name, 'Player 10');
});
