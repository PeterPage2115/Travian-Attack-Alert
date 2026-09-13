'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const script = require(path.join(ROOT, 'script.txt'));
const GENERATION = '6.0.0';
const HOST = 'cw.x2.international.travian.com';
const OBSERVED_AT = Date.UTC(2026, 7, 23, 9, 46, 1, 0);
const DISPATCHED_AT = OBSERVED_AT;
const BASE_SETTINGS = script.validateSettings({
    attackThreshold: 1,
    raidThreshold: 1,
    normalMax: 2,
    highMax: 5
});
const CUSTOM_SETTINGS = script.validateSettings({
    attackThreshold: 1,
    raidThreshold: 1,
    normalMax: 1,
    highMax: 3
});
const BASE_OPTIONS = {
    allianceUrl: `https://${HOST}/alliance/members`,
    context: {
        origin: `https://${HOST}`,
        fallbackHref: `https://${HOST}/alliance/members`
    },
    worldHostname: HOST,
    settings: BASE_SETTINGS,
    approximateObserved: false,
    observedAtMs: OBSERVED_AT,
    dispatchedAtMs: DISPATCHED_AT,
    roleId: null,
    leaveRoleId: null,
    userIds: []
};

function event(testId, name, id, counts, eventType, extra = {}) {
    return {
        testId,
        name,
        url: `/profile/${id}`,
        ...counts,
        eventType,
        ...extra
    };
}

function options(overrides = {}) {
    return Object.assign({}, BASE_OPTIONS, overrides);
}

const previewCases = {
    'raid-two': () => ({
        events: [
            event('raid-lenny', 'Lenny Barre', 101, { attackCount: 0, raidCount: 1, addedAttackCount: 0, addedRaidCount: 1 }, 'raid'),
            event('raid-quinnos', 'Quinnos', 102, { attackCount: 0, raidCount: 1, addedAttackCount: 0, addedRaidCount: 1 }, 'raid')
        ],
        options: options()
    }),
    'attack-mixed-six': () => ({
        events: [
            event('attack-player-365', 'Player 365', 365, { attackCount: 17, raidCount: 5, addedAttackCount: 2, addedRaidCount: 0 }, 'attack'),
            event('attack-sandla', 'sandla', 1, { attackCount: 7, raidCount: 7, addedAttackCount: 2, addedRaidCount: 0 }, 'attack'),
            event('mixed-ariadne', 'Ariadne', 2, { attackCount: 8, raidCount: 1, addedAttackCount: 1, addedRaidCount: 1 }, 'mixed'),
            event('mixed-borek', 'Borek', 3, { attackCount: 6, raidCount: 2, addedAttackCount: 1, addedRaidCount: 1 }, 'mixed'),
            event('mixed-ciri', 'Ciri', 4, { attackCount: 7, raidCount: 1, addedAttackCount: 1, addedRaidCount: 1 }, 'mixed'),
            event('attack-darek', 'Darek', 5, { attackCount: 7, raidCount: 1, addedAttackCount: 1, addedRaidCount: 0 }, 'attack')
        ],
        options: options()
    }),
    roster: () => ({
        events: [
            event('roster-alpha-join', 'Alpha', 201, { attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0 }, 'join'),
            event('roster-beta-leave', 'Beta', 202, { attackCount: 0, raidCount: 0, addedAttackCount: 0, addedRaidCount: 0 }, 'leave')
        ],
        options: options()
    }),
    approximate: () => ({
        events: [event(
            'approximate-301',
            'Approximate Player',
            301,
            { attackCount: 2, raidCount: 1, addedAttackCount: 1, addedRaidCount: 0 },
            'attack',
            { observedAtMs: OBSERVED_AT - 2000, approximateObserved: true, observedAtApproximate: true }
        )],
        options: options()
    }),
    'unavailable-time': () => ({
        events: [event(
            'unavailable-302',
            'Unavailable Time',
            302,
            { attackCount: 1, raidCount: 0, addedAttackCount: 1, addedRaidCount: 0 },
            'attack'
        )],
        options: options({ observedAtMs: undefined })
    }),
    'custom-priority': () => ({
        events: [
            event('custom-high', 'Custom High', 303, { attackCount: 3, raidCount: 0, addedAttackCount: 2, addedRaidCount: 0 }, 'attack'),
            event('custom-critical', 'Custom Critical', 304, { attackCount: 7, raidCount: 0, addedAttackCount: 4, addedRaidCount: 0 }, 'attack')
        ],
        options: options({ settings: CUSTOM_SETTINGS })
    }),
    'players-60': () => ({
        events: Array.from({ length: 60 }, (_, index) => event(
            `players-60-${String(index + 1).padStart(2, '0')}`,
            `Player ${String(index + 1).padStart(2, '0')}`,
            index + 301,
            { attackCount: 52, raidCount: 17, addedAttackCount: 1, addedRaidCount: 0 },
            'attack'
        )),
        options: options()
    }),
    'forced-split': () => ({
        events: Array.from({ length: 60 }, (_, index) => event(
            `forced-split-${String(index).padStart(2, '0')}`,
            `Long Player ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
            index + 401,
            { attackCount: 52, raidCount: 17, addedAttackCount: 1, addedRaidCount: 1 },
            'mixed'
        )),
        options: options()
    }),
    unicode: () => ({
        events: [event(
            'unicode-501',
            `👨‍👩‍👧‍👦é—${'🛡️'.repeat(40)}`,
            `501?a=${'a'.repeat(260)}`,
            { attackCount: 2, raidCount: 1, addedAttackCount: 1, addedRaidCount: 1 },
            'mixed'
        )],
        options: options()
    })
};

const previewCaseNames = Object.freeze(Object.keys(previewCases));

function payloadsForCase(caseName) {
    const definition = previewCases[caseName];
    if (!definition) return null;
    const fixture = definition();
    return script.buildDiscordPayloads(fixture.events, fixture.options);
}

function serializePayloadsForDocumentation(payloads) {
    const lines = ['```text'];
    for (const payload of payloads) {
        for (const embed of payload.embeds) {
            if (typeof embed.title === 'string') lines.push(embed.title);
            lines.push(embed.description);
            for (const field of embed.fields || []) lines.push(`${field.name}: ${field.value}`);
            if (embed.footer && typeof embed.footer.text === 'string') lines.push(embed.footer.text);
            if (typeof embed.timestamp === 'string') lines.push(`Timestamp: ${embed.timestamp}`);
        }
    }
    lines.push('```');
    return lines.join('\n');
}

module.exports = {
    BASE_OPTIONS,
    GENERATION,
    HOST,
    OBSERVED_AT,
    previewCaseNames,
    previewCases,
    payloadsForCase,
    serializePayloadsForDocumentation
};
