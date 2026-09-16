'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const impl = require(path.join(SRC, 'parser-impl.js'));
const parser = require(path.join(SRC, 'parser.js'));

const CONTRACT = [
  'isAttackIcon', 'parseAttackCount', 'parseRaidCount', 'classifyEvent',
  'selectMemberTable', 'selectAuthoritativeMemberTable',
  'isAlliancePageReady', 'isReadinessReady', 'checkTooltipSourceAgreement',
  'parseNormalizedMemberIcon', 'parseNormalizedMemberRow',
  'buildStableTableSignature', 'extractMembersFromTable',
  'extractAllianceSnapshotFromRows', 'extractAllianceSnapshotFromDocument',
  'parseMemberSnapshot', 'buildAllianceSnapshot',
];
const T0 = 1700000000000;

function node({ text = '', attributes = {}, className = '', rows = [], links = [], images = [], headers = [] } = {}) {
  const value = {
    textContent: text,
    className,
    parentElement: null,
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute: (name) => Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null,
    querySelectorAll(selector) {
      if (selector === 'tr') return rows;
      if (selector === 'a') return links;
      if (selector === 'img') return images;
      if (selector === 'th') return headers;
      return [];
    },
  };
  value.classList = { contains: (name) => String(className).split(/\s+/u).includes(name) };
  return value;
}

function row(id, name, tooltips = []) {
  const link = node({ text: name, attributes: { href: id === null ? '/profile/missing' : `/profile/${id}` } });
  const images = tooltips.map((tooltip) => node({ className: 'attack', attributes: { title: tooltip, alt: tooltip } }));
  const value = node({ links: [link], images });
  for (const image of images) image.parentElement = value;
  return value;
}

function table(rows, attributes = {}) {
  const value = node({ className: 'allianceMembers', rows });
  value.getAttribute = (name) => Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
  return value;
}

function documentWith(tables) {
  return {
    location: { origin: 'https://s1.example.test' },
    querySelectorAll: (selector) => selector === 'table' ? tables : [],
  };
}

test('parser source exposes exactly the 17-symbol contract without runtime-api', () => {
  assert.deepEqual(Object.keys(parser).sort(), [...CONTRACT].sort());
  assert.equal(Object.keys(parser).length, 17);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'parser.js'), 'utf8'), /runtime-api/u);
});

test('count parsing and attack classification preserve multilingual results', () => {
  for (const description of ['2 attacks 3 raids', '4 ataki 5 grabieży', '6 Angriffe 7 Raubzüge', '😀 8 attacks']) {
    assert.deepEqual(impl.classifyEvent(description), runtime.classifyEvent(description));
  }
  assert.equal(impl.parseAttackCount('0 attacks'), null);
  assert.equal(impl.parseRaidCount('raid'), null);
  assert.equal(impl.isAttackIcon({ className: 'attack', description: '2 raids' }), true);
  assert.equal(impl.isAttackIcon({ className: 'scout', description: '2 attacks' }), false);
});

test('tooltip agreement preserves duplicate, conflicting, and malformed outcomes', () => {
  const fixtures = [
    ['1 attack 2 raids', '1 attack 2 raids'],
    ['1 attack', '2 attacks'],
    ['attack', 'attack'],
    ['😀 3 raids'],
  ];
  for (const sources of fixtures) {
    assert.deepEqual(impl.checkTooltipSourceAgreement(sources), runtime.checkTooltipSourceAgreement(sources));
  }
});

test('normalized icon and row parsing preserve event counts and anomalies', () => {
  const icon = { className: 'attack', tooltipSources: ['2 attacks 1 raid'] };
  assert.deepEqual(impl.parseNormalizedMemberIcon(icon), runtime.parseNormalizedMemberIcon(icon));
  const member = { id: ' 101 ', name: ' Alpha 😀 ', url: ' /profile/101 ', icons: [icon] };
  assert.deepEqual(impl.parseNormalizedMemberRow(member), runtime.parseNormalizedMemberRow(member));
});

test('stable signatures preserve UTF-16 hashing and normalized ordering', () => {
  const fixture = { rows: [{ id: '101', name: 'Żółć 😀', url: '/profile/101', icons: [{ tooltipSources: ['2 raids', '1 attack'] }] }] };
  assert.equal(impl.buildStableTableSignature(fixture), runtime.buildStableTableSignature(fixture));
  assert.match(impl.buildStableTableSignature(fixture), /^alliance-members-v1:[0-9a-f]{8}$/u);
});

test('row snapshots preserve authoritative, partial, missing, duplicate, conflicting, and malformed states', () => {
  const fixtures = [
    { rows: [{ id: '101', name: 'Alpha', url: '/profile/101', icons: [] }] },
    { rows: [{ id: '101', name: 'Alpha', url: '/profile/101', icons: [] }], paginationOrFilter: true },
    { rows: [{ id: '', name: 'Alpha', url: '', icons: [] }] },
    { rows: [{ id: '101', name: 'Alpha', url: '', icons: [] }, { id: '101', name: 'Beta', url: '', icons: [] }] },
    { rows: [{ id: '101', name: 'Alpha', url: '', icons: [{ className: 'attack', tooltipSources: ['1 attack', '2 attacks'] }] }] },
    { rows: [{ id: '101', name: 'Alpha', url: '', icons: [{ className: 'attack', tooltipSources: ['attack'] }] }] },
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(impl.buildAllianceSnapshot(fixture, T0), runtime.buildAllianceSnapshot(fixture, T0));
  }
});

test('member-table rejection table preserves exact reason codes and no accepted table', () => {
  const accepted = table([row('101', 'Alpha', ['1 attack'])]);
  const fixtures = [
    ['no-member-table', documentWith([])],
    ['multiple-member-tables', documentWith([accepted, accepted])],
    ['pagination-or-filter', documentWith([table([row('101', 'Alpha')], { 'data-pagination': 'true' })])],
  ];
  for (const [reason, document] of fixtures) {
    assert.deepEqual(impl.selectMemberTable(document), { status: 'rejected', reason, table: null });
    assert.equal(impl.selectAuthoritativeMemberTable(document), null);
  }
  assert.equal(impl.selectAuthoritativeMemberTable(documentWith([accepted])), accepted);
});

test('document snapshots reject missing, duplicate, conflicting, and malformed rows without members', () => {
  const conflict = row('102', 'Beta', ['1 attack']);
  conflict.querySelectorAll('img')[0].getAttribute = (name) => name === 'title' ? '1 attack' : name === 'data-tooltip' ? '2 attacks' : null;
  const fixtures = [
    ['missing-player-id', [row(null, 'Alpha', ['1 attack'])]],
    ['duplicate-player-id', [row('101', 'Alpha'), row('101', 'Beta')]],
    ['conflicting-tooltip', [row('101', 'Alpha', ['1 attack']), conflict]],
    ['malformed-count', [row('101', 'Alpha', ['attack'])]],
  ];
  for (const [reason, rows] of fixtures) {
    const actual = impl.extractAllianceSnapshotFromDocument(documentWith([table(rows)]), T0);
    assert.equal(actual.status, 'rejected');
    assert.equal(actual.reason, reason);
    assert.deepEqual(actual.membersById, {});
  }
});

test('document parser aliases preserve accepted snapshots', () => {
  const document = documentWith([table([row('101', 'Alpha', ['2 attacks 1 raid'])])]);
  assert.deepEqual(impl.extractAllianceSnapshotFromDocument(document, T0), runtime.extractAllianceSnapshotFromDocument(document, T0));
  assert.deepEqual(impl.parseMemberSnapshot(document, T0), runtime.parseMemberSnapshot(document, T0));
});

test('readiness requires complete state, a table, a row, and the frozen quiet window', () => {
  assert.equal(impl.isAlliancePageReady('complete', true, true), true);
  assert.equal(impl.isAlliancePageReady('interactive', true, true), false);
  assert.equal(impl.isReadinessReady('complete', true, 499), false);
  assert.equal(impl.isReadinessReady('complete', true, 500), true);
  assert.equal(impl.isReadinessReady('complete', true, 25, 25), true);
});
