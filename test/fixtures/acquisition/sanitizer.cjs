'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const GOLDEN = path.join(ROOT, 'golden');
const FIXTURE_NAMES = Object.freeze([
    'members-60', 'members-59-incident', 'overview', 'reports-paginated', 'report-detail'
]);

function fakeName(index) { return `Fixture Player ${String(index).padStart(3, '0')}`; }
// Keep the production URL shape while staying outside any real capture IDs.
function fakeId(index) { return String(900000 + index); }

function tokenizeRows(source) {
    const table = source.match(/<table\b[^>]*class\s*=\s*["'][^"']*\ballianceMembers\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i);
    if (!table) return [];
    return [...table[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(match => match[1])
        .filter(row => /class\s*=\s*["'][^"']*\bplayer\b/i.test(row));
}

function textOf(value) { return value.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(); }

function sanitizeHtml(source, contract) {
    const rows = tokenizeRows(source);
    const renderedRows = rows.map((row, index) => {
        const attack = row.match(/<img\b[^>]*class\s*=\s*["'][^"']*\battack\b[^"']*["'][^>]*>/i);
        const tooltip = attack && ((attack[0].match(/title\s*=\s*["']([^"']*)["']/i) || [])[1] || '');
        const count = /(?:^|\D)1(?:\D|$)/.test(tooltip) ? 1 : 0;
        return `<tr data-row="${fakeId(index + 1)}"><td class="player"><a href="/profile/${fakeId(index + 1)}">${fakeName(index + 1)}</a>${count ? `<img class="attack" title="1 attack" alt="1 attack">` : ''}</td></tr>`;
    });
    return `<main data-route-role="${contract.routeRole}" data-rejection-reason="${contract.rejectionReason || ''}"><div class="content"><table class="allianceMembers"><tbody>${renderedRows.join('')}</tbody></table>${contract.pagination ? '<nav class="pagination"><a href="/page/1">1</a><a href="/page/2">2</a></nav>' : ''}</div></main>`;
}

function syntheticMemberSource(count, incident) {
    const rows = Array.from({ length: count }, (_, index) => `<tr><td class="player"><a href="https://real.example/profile/${1000 + index}">Real Name ${index}</a>${incident && (index === 10 || index === 41) ? '<img class="attack" title="1 atak" alt="1 atak">' : ''}</td></tr>`);
    return `<html><head><script src="https://real.example/app.js"></script></head><body><div class="villageList">${rows[0]}</div><table class='allianceMembers'>${rows.join('')}</table><script>document.cookie='secret'</script></body></html>`;
}

function buildFixtures() {
    const specs = {
        'members-60': { count: 60, routeRole: 'authoritative', rejectionReason: null },
        'members-59-incident': { count: 59, incident: true, routeRole: 'authoritative', rejectionReason: null },
        overview: { count: 0, routeRole: 'non-authoritative', rejectionReason: 'non-member-route' },
        'reports-paginated': { count: 0, routeRole: 'non-authoritative', rejectionReason: 'reports-route', pagination: true },
        'report-detail': { count: 0, routeRole: 'non-authoritative', rejectionReason: 'report-detail-route' }
    };
    return Object.fromEntries(FIXTURE_NAMES.map(name => {
        const spec = specs[name];
        const source = spec.count ? syntheticMemberSource(spec.count, spec.incident) : '<html><body><div class="account"><script>secret</script></div></body></html>';
        return [name, { html: spec.count ? sanitizeHtml(source, spec) : `<main data-route-role="${spec.routeRole}" data-rejection-reason="${spec.rejectionReason}"><div class="content">${spec.pagination ? '<nav class="pagination"><a href="/page/1">1</a></nav>' : ''}</div></main>` }];
    }));
}

function contractFor(name, html) {
    const rows = [...html.matchAll(/<tr\b/g)].length;
    const icons = [...html.matchAll(/<img\b[^>]*class="attack"[^>]*title="([^"]*)"/g)];
    const attackSum = icons.reduce((sum, [, tooltip]) => sum + (tooltip.includes('1 attack') ? 1 : 0), 0);
    const main = html.match(/<main\b[^>]*>/)[0];
    return { routeRole: /data-route-role="authoritative"/.test(main) ? 'authoritative' : 'non-authoritative', tableCount: (html.match(/<table\b/g) || []).length, rowCount: rows, uniqueRowCount: new Set([...html.matchAll(/data-row="([^"]+)"/g)].map(match => match[1])).size, iconCount: icons.length, attackSum, raidSum: 0, rejectionReason: (main.match(/data-rejection-reason="([^"]*)"/) || [])[1] || null };
}

function writeFixtures() {
    const fixtures = buildFixtures();
    for (const [name, fixture] of Object.entries(fixtures)) {
        fs.writeFileSync(path.join(ROOT, `${name}.html`), `${fixture.html}\n`);
        fs.writeFileSync(path.join(GOLDEN, `${name}.json`), `${JSON.stringify(contractFor(name, fixture.html), null, 2)}\n`);
    }
    const files = [...FIXTURE_NAMES.flatMap(name => [`${name}.html`, `golden/${name}.json`])];
    const manifest = Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));
    fs.writeFileSync(path.join(ROOT, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, files: manifest }, null, 2)}\n`);
    return fixtures;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readGoldenContracts() { return Object.fromEntries(FIXTURE_NAMES.map(name => [name, JSON.parse(fs.readFileSync(path.join(GOLDEN, `${name}.json`), 'utf8'))])); }

if (require.main === module) writeFixtures();
module.exports = { FIXTURE_NAMES, buildFixtures, contractFor, readGoldenContracts, sanitizeHtml, sha256, writeFixtures };
