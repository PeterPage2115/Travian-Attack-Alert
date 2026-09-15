'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const SCRIPT = fs.readFileSync(path.resolve(ROOT, '..', '..', '..', 'src', 'runtime.js'), 'utf8');
const REASONS = Object.freeze([
    'no-member-table', 'multiple-member-tables', 'pagination-or-filter',
    'missing-player-id', 'duplicate-player-id', 'conflicting-tooltip',
    'malformed-count'
]);

function html(name) { return fs.readFileSync(path.join(ROOT, `${name}.html`), 'utf8'); }

async function withParser(documentHtml, callback) {
    const browser = await chromium.launch({ headless: true });
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(documentHtml);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage();
        const address = server.address();
        await page.goto(`http://127.0.0.1:${address.port}/fixture.html`);
        await page.addScriptTag({ content: `var module = { exports: {} };\n${SCRIPT}\nwindow.__taaParser = module.exports;` });
        return await callback(page);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await browser.close();
    }
}

async function extractFixtureSnapshots(names) {
    const output = {};
    for (const name of names) {
        output[name] = await withParser(html(name), page => page.evaluate(() =>
            window.__taaParser.extractAllianceSnapshotFromDocument(document, 1700000000000)));
    }
    return output;
}

async function extractPairedZeroFixtureSnapshot() {
    return withParser(html('paired-zero-members'), page => page.evaluate(() => {
        const storageBefore = JSON.stringify({ ...localStorage });
        const snapshot = window.__taaParser.extractAllianceSnapshotFromDocument(document, 1700000000000);
        const storageAfter = JSON.stringify({ ...localStorage });
        return { snapshot, storageBefore, storageAfter };
    }));
}

function rejectionHtml(reason) {
    const source = html('members-59-incident');
    if (reason === 'no-member-table') return '<main></main>';
    if (reason === 'multiple-member-tables') return source.replace('</main>', `${source.match(/<table[\s\S]*?<\/table>/i)[0]}</main>`);
    if (reason === 'pagination-or-filter') return source.replace('class="allianceMembers"', 'class="allianceMembers" data-pagination="true"');
    if (reason === 'missing-player-id') return source.replace('/profile/900001', '/profile/not-a-number');
    if (reason === 'duplicate-player-id') return source.replace('/profile/900002', '/profile/900001');
    if (reason === 'conflicting-tooltip') return source.replace('title="1 attack" alt="1 attack"', 'title="1 attack" data-tooltip="2 attacks" alt="1 attack"');
    if (reason === 'malformed-count') return source.replace('title="1 attack" alt="1 attack"', 'title="attack" alt="attack"');
    throw new Error(`unknown rejection reason: ${reason}`);
}

async function extractRejectedFixtureSnapshots(reasons = REASONS) {
    const output = {};
    for (const reason of reasons) {
        output[reason] = await withParser(rejectionHtml(reason), async page => page.evaluate(expected => {
            const before = JSON.stringify({ ...localStorage });
            const snapshot = window.__taaParser.extractAllianceSnapshotFromDocument(document, 1700000000000);
            const after = JSON.stringify({ ...localStorage });
            return { snapshot: { status: snapshot.status, reason: snapshot.reason }, storageBefore: before, storageAfter: after, expected };
        }, reason));
    }
    return output;
}

module.exports = { extractFixtureSnapshots, extractPairedZeroFixtureSnapshot, extractRejectedFixtureSnapshots, REASONS };
