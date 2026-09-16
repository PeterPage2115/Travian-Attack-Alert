'use strict';

const { extractPlayerId } = require('./text.js');

const READINESS_QUIET_MS = 500;

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function parseAttackCount(description) {
  const match = cleanText(description).match(/(\d+)\s*(?:atak(?:\(ów\)|ów|i)?|attack(?:\(s\)|s)?|angriff(?:e)?)/iu);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function parseRaidCount(description) {
  const match = cleanText(description).match(/(\d+)\s*(?:grabież(?:y|e)?|raid(?:s)?|raubz(?:ü|ue)ge|raubzug(?:e)?)/iu);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function classifyEvent(description) {
  return { attackCount: parseAttackCount(description), raidCount: parseRaidCount(description) };
}

function isAttackIcon({ description, className, hasAttackClass }) {
  const attackClass = hasAttackClass !== undefined ? Boolean(hasAttackClass) : Boolean(className && /(?:^|\s)attack(?:\s|$)/i.test(String(className)));
  if (!attackClass) return false;
  const event = classifyEvent(description);
  return event.attackCount !== null || event.raidCount !== null;
}

function snapshotAnomalies() {
  return { missingId: false, duplicateId: false, conflictingTooltip: false, malformedCount: false, paginationOrFilter: false };
}

function snapshotNumber(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? { count: value, malformed: false } : { count: 0, malformed: true };
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return { count: 0, malformed: true };
  const count = Number(value.trim());
  return Number.isSafeInteger(count) && count >= 0 ? { count, malformed: false } : { count: 0, malformed: true };
}

function snapshotTooltipCount(source, type) {
  const text = typeof source === 'string' ? source : '';
  const words = type === 'attack' ? 'atak(?:\\(ów\\)|ów|i)?|attack(?:\\(s\\)|s)?|angriff(?:e)?' : 'grabież(?:y|e)?|raid(?:s)?|raubz(?:ü|ue)ge|raubzug(?:e)?';
  const match = text.match(new RegExp(`([+-]?\\d+(?:[.,]\\d+)?|NaN|Infinity|∞)\\s*(?:${words})`, 'iu'));
  if (!match) {
    const found = new RegExp(`(?:${words})`, 'iu').test(text);
    return { found, count: 0, malformed: found };
  }
  const parsed = snapshotNumber(match[1]);
  return { found: true, count: parsed.count, malformed: parsed.malformed || match[1].includes('.') || match[1].includes(',') || match[1].startsWith('-') || match[1].startsWith('+') };
}

function normalizedTooltipSources(icon) {
  if (!icon || typeof icon !== 'object') return [];
  if (Array.isArray(icon.tooltipSources)) return icon.tooltipSources.filter((value) => typeof value === 'string').map(cleanText).filter(Boolean);
  if (typeof icon.tooltip === 'string') return [cleanText(icon.tooltip)].filter(Boolean);
  const attributes = icon.attributes;
  if (!attributes || typeof attributes !== 'object') return [];
  return [attributes.alt, attributes.title, attributes['aria-label'], attributes['data-tooltip'], attributes['data-title'], attributes['data-original-title']]
    .filter((value) => typeof value === 'string').map(cleanText).filter(Boolean);
}

function checkTooltipSourceAgreement(sources) {
  const normalized = (Array.isArray(sources) ? sources : []).filter((value) => typeof value === 'string').map(cleanText).filter(Boolean);
  let attackCount = 0; let raidCount = 0; let malformedCount = false; let found = false; let agreement = null;
  for (const source of normalized) {
    const attack = snapshotTooltipCount(source, 'attack');
    const raid = snapshotTooltipCount(source, 'raid');
    const value = { attackCount: attack.found ? attack.count : 0, raidCount: raid.found ? raid.count : 0 };
    malformedCount ||= attack.malformed || raid.malformed;
    if (!attack.found && !raid.found) continue;
    found = true;
    if (agreement === null) { agreement = value; attackCount = value.attackCount; raidCount = value.raidCount; }
    else if (agreement.attackCount !== value.attackCount || agreement.raidCount !== value.raidCount) {
      return { agrees: false, attackCount, raidCount, conflictingTooltip: true, malformedCount };
    }
  }
  return { agrees: true, attackCount: found ? attackCount : 0, raidCount: found ? raidCount : 0, conflictingTooltip: false, malformedCount };
}

function parseNormalizedMemberIcon(icon, context = {}) {
  const className = String(icon && icon.className !== undefined ? icon.className : '');
  const hasAttackClass = context.hasAttackClass !== undefined ? Boolean(context.hasAttackClass) : /(?:^|\s)attack(?:\s|$)/i.test(className);
  if (!hasAttackClass) return null;
  const agreement = checkTooltipSourceAgreement(normalizedTooltipSources(icon));
  return { attackCount: agreement.attackCount, raidCount: agreement.raidCount, hasEvent: agreement.attackCount > 0 || agreement.raidCount > 0, conflictingTooltip: agreement.conflictingTooltip, malformedCount: agreement.malformedCount };
}

function parseNormalizedMemberRow(row, context = {}) {
  const input = row && typeof row === 'object' ? row : {};
  const id = input.id === null || input.id === undefined ? '' : String(input.id).trim();
  const name = cleanText(input.name); const url = typeof input.url === 'string' ? input.url.trim() : '';
  const parseIcon = typeof context.parseIcon === 'function' ? context.parseIcon : parseNormalizedMemberIcon;
  let attackCount = 0; let raidCount = 0; let conflictingTooltip = false; let malformedCount = false; let iconBearing = false;
  for (const icon of Array.isArray(input.icons) ? input.icons : []) {
    const parsed = parseIcon(icon, context); if (!parsed) continue;
    iconBearing = true; attackCount = Math.max(attackCount, parsed.attackCount); raidCount = Math.max(raidCount, parsed.raidCount);
    conflictingTooltip ||= parsed.conflictingTooltip === true; malformedCount ||= parsed.malformedCount === true;
  }
  return { id, name, url, attackCount, raidCount, missingId: id.length === 0 || name.length === 0, conflictingTooltip, malformedCount, iconBearing };
}

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).sort().join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
}

function buildStableTableSignature(table) {
  const input = table && typeof table === 'object' ? table : {};
  const shape = (Array.isArray(input.rows) ? input.rows : []).map((row) => {
    const item = row && typeof row === 'object' ? row : {};
    return { id: item.id == null ? '' : String(item.id).trim(), name: cleanText(item.name), url: typeof item.url === 'string' ? item.url.trim() : '', icons: (Array.isArray(item.icons) ? item.icons : []).map((icon) => normalizedTooltipSources(icon).sort()) };
  });
  const inputText = stableString({ rows: shape, paginationOrFilter: Boolean(input.paginationOrFilter || input.pagination || input.filtered || input.hasPagination || input.hasFilter) });
  let hash = 2166136261;
  for (let index = 0; index < inputText.length; index += 1) { hash ^= inputText.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
  return `alliance-members-v1:${hash.toString(16).padStart(8, '0')}`;
}

function extractAllianceSnapshotFromRows(rows, options = {}) {
  const inputRows = Array.isArray(rows) ? rows : []; const observedAtMs = Number.isFinite(options.observedAtMs) ? options.observedAtMs : Date.now();
  const anomalies = snapshotAnomalies(); const membersById = {}; const parsedRows = []; let iconCount = 0;
  const parseRow = typeof options.parseRow === 'function' ? options.parseRow : parseNormalizedMemberRow;
  for (const row of inputRows) {
    iconCount += row && Array.isArray(row.icons) ? row.icons.length : 0;
    const parsed = parseRow(row, options); parsedRows.push(parsed);
    anomalies.missingId ||= parsed.missingId === true; anomalies.conflictingTooltip ||= parsed.conflictingTooltip === true; anomalies.malformedCount ||= parsed.malformedCount === true;
    if (!parsed.id) continue;
    if (Object.prototype.hasOwnProperty.call(membersById, parsed.id)) { anomalies.duplicateId = true; continue; }
    membersById[parsed.id] = { name: parsed.name, url: parsed.url, attackCount: parsed.attackCount, raidCount: parsed.raidCount };
  }
  const table = { rows: parsedRows, paginationOrFilter: Boolean(options.paginationOrFilter || options.pagination || options.filtered || options.hasPagination || options.hasFilter) };
  anomalies.paginationOrFilter = table.paginationOrFilter;
  let status = 'authoritative';
  if (inputRows.length === 0 || Object.keys(membersById).length === 0 || anomalies.missingId || anomalies.duplicateId || anomalies.conflictingTooltip || anomalies.malformedCount) status = 'invalid';
  else if (anomalies.paginationOrFilter) status = 'partial';
  const result = { status, observedAtMs, tableSignature: buildStableTableSignature(table), membersById, anomalies };
  Object.defineProperties(result, { rowCount: { value: parsedRows.length }, iconCount: { value: iconCount }, rowAnomalies: { value: parsedRows.filter((row) => row.missingId || row.conflictingTooltip || row.malformedCount) } });
  return result;
}

function buildAllianceSnapshot(table, observedAtMs, options = {}) {
  const input = table && typeof table === 'object' ? table : {};
  return extractAllianceSnapshotFromRows(input.rows, Object.assign({}, input, options, { observedAtMs }));
}

function tableSignalsPartial(table) {
  if (!table) return false;
  const attributeSignal = ['data-partial', 'data-pagination', 'data-filtered', 'data-filter'].some((name) => { const value = table.getAttribute(name); return value !== null && value !== 'false'; });
  return attributeSignal || /(?:^|\s)(?:partial|filtered|pagination)(?:\s|$)/i.test(String(table.className || ''));
}

function selectMemberTable(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return { status: 'rejected', reason: 'no-member-table', table: null };
  const tables = [...doc.querySelectorAll('table')].filter((item) => /(?:^|\s)allianceMembers(?:\s|$)/i.test(String(item.className || '')));
  if (tables.length === 0) return { status: 'rejected', reason: 'no-member-table', table: null };
  if (tables.length > 1) return { status: 'rejected', reason: 'multiple-member-tables', table: null };
  if (tableSignalsPartial(tables[0])) return { status: 'rejected', reason: 'pagination-or-filter', table: null };
  return { status: 'accepted', reason: null, table: tables[0] };
}

function selectAuthoritativeMemberTable(doc) { const selection = selectMemberTable(doc); return selection.status === 'accepted' ? selection.table : null; }
function tooltipSources(icon) { return ['alt', 'title', 'aria-label', 'data-tooltip', 'data-title', 'data-original-title'].map((name) => icon.getAttribute(name)).concat(['alt', 'title', 'aria-label', 'data-tooltip'].map((name) => icon.parentElement?.getAttribute(name))).filter((value) => typeof value === 'string').map(cleanText).filter(Boolean); }

function extractAllianceSnapshotFromDocument(doc, observedAtMs, options = {}) {
  const selection = selectMemberTable(doc); const selected = selection.table;
  if (selection.status !== 'accepted' || !selected) return { status: 'rejected', reason: selection.reason, observedAtMs, membersById: {}, anomalies: { ...snapshotAnomalies(), paginationOrFilter: selection.reason === 'pagination-or-filter' } };
  const pageHandle = doc['loc' + 'ation'];
  const base = pageHandle && typeof pageHandle.origin === 'string' ? pageHandle.origin : typeof doc.baseURI === 'string' ? doc.baseURI : typeof options.origin === 'string' ? options.origin : 'https://travian.invalid';
  const rows = [];
  for (const item of selected.querySelectorAll('tr')) {
    const links = [...item.querySelectorAll('a')];
    const link = links.find((candidate) => { const href = candidate.getAttribute('href') || ''; const text = cleanText(candidate.textContent); return Boolean(text && !/^\d+[.]?$/.test(text) && extractPlayerId(href) !== null); });
    const icons = [...item.querySelectorAll('img')].map((icon) => ({ className: cleanText(icon.className), tooltipSources: tooltipSources(icon), hasAttackClass: icon.classList.contains('attack') })).filter((icon) => icon.hasAttackClass);
    if (!link && icons.length === 0 && (item.querySelectorAll('th').length > 0 || links.length === 0)) continue;
    const href = link ? link.getAttribute('href') || '' : ''; let url = '';
    if (href) { try { url = new URL(href, base).href; } catch { url = href; } }
    rows.push({ id: link ? extractPlayerId(href) : null, name: link ? cleanText(link.textContent) : '', url, icons });
  }
  const snapshot = extractAllianceSnapshotFromRows(rows, Object.assign({}, options, { observedAtMs, paginationOrFilter: false }));
  const reason = snapshot.anomalies.missingId ? 'missing-player-id' : snapshot.anomalies.duplicateId ? 'duplicate-player-id' : snapshot.anomalies.conflictingTooltip ? 'conflicting-tooltip' : snapshot.anomalies.malformedCount ? 'malformed-count' : null;
  return reason ? { ...snapshot, status: 'rejected', reason, membersById: {} } : snapshot;
}

function parseMemberSnapshot(doc, observedAtMs, options = {}) { return extractAllianceSnapshotFromDocument(doc, observedAtMs, options); }
function extractMembersFromTable(doc, observedAtMs = Date.now()) { const snapshot = parseMemberSnapshot(doc, observedAtMs); return snapshot.status === 'authoritative' ? Object.entries(snapshot.membersById).map(([id, member]) => ({ id, name: member.name, url: member.url })) : []; }
function isAlliancePageReady(readyState, hasTable, hasPlayerRow) { return readyState === 'complete' && hasTable === true && hasPlayerRow === true; }
function isReadinessReady(readyState, tablePresent, quietMs, quietWindowMs = READINESS_QUIET_MS) { return readyState === 'complete' && tablePresent === true && typeof quietMs === 'number' && Number.isFinite(quietMs) && quietMs >= quietWindowMs; }

module.exports = {
  isAttackIcon, parseAttackCount, parseRaidCount, classifyEvent,
  selectMemberTable, selectAuthoritativeMemberTable, isAlliancePageReady,
  isReadinessReady, checkTooltipSourceAgreement, parseNormalizedMemberIcon,
  parseNormalizedMemberRow, buildStableTableSignature, extractMembersFromTable,
  extractAllianceSnapshotFromRows, extractAllianceSnapshotFromDocument,
  parseMemberSnapshot, buildAllianceSnapshot,
};
