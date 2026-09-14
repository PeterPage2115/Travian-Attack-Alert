'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtimeApi = require(path.join(root, 'src', 'runtime-api.js'));
const constants = require(path.join(root, 'src', 'constants.js'));
const text = require(path.join(root, 'src', 'text.js'));
const route = require(path.join(root, 'src', 'route.js'));

function selected(names) {
    return runtimeApi.select('pure-module-parity', names);
}

test('pure seams preserve the legacy public names and fixture outputs', () => {
    const contracts = [
        ['constants', constants, Object.keys(constants)],
        ['text', text, Object.keys(text)],
        ['route', route, Object.keys(route)]
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
        for (const name of ['constants', 'text', 'route']) {
            const value = require(${JSON.stringify(path.join(root, 'src'))} + '/' + name + '.js');
            if (!value || Object.keys(value).length === 0) throw new Error(name + ' did not load');
        }
    `;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }));
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
