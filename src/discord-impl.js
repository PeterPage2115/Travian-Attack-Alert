'use strict';

const {
  DISCORD_CONTENT_LIMIT, DISCORD_EMBEDS_LIMIT, EMBED_DESCRIPTION_LIMIT,
  EMBED_DESCRIPTION_SAFE_BUDGET, EMBED_FIELD_VALUE_LIMIT, EMBED_TOTAL_TEXT_LIMIT,
  EVENT_NAME_MAX, PAYLOAD_CHUNK_MAX, PRIORITY_COLORS,
} = require('./constants.js');
const { filterMutedEvents, classifyPriority } = require('./snapshot-impl.js');
const {
  encodeMarkdownUrl, extractPlayerId, raidWord, safeAllianceUrl, safeProfileUrl,
  truncateText, validateDiscordRoleId, validateDiscordUserId,
} = require('./text.js');

function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function escapeDiscordMarkdown(value) { return String(value || '').replace(/([\\`*_{}\[\]()~>#+\-.!|])/g, '\\$1'); }
function attackWord(count) { return count === 1 ? 'attack' : 'attacks'; }
function discordEventCount(event, key) { const value = event && Number(event[key]); return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
function eventRank(event) { return event && (event.eventType === 'join' || event.eventType === 'leave') ? 2 : event && event.eventType === 'raid' && discordEventCount(event, 'addedAttackCount') === 0 ? 1 : 0; }
function requireSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Number.isInteger(settings.attackThreshold) || !Number.isInteger(settings.raidThreshold) || !Number.isInteger(settings.normalMax) || !Number.isInteger(settings.highMax) || settings.attackThreshold < 1 || settings.raidThreshold < 1 || settings.normalMax < 1 || settings.normalMax >= settings.highMax) throw new TypeError('discord-settings-must-be-validated');
  return settings;
}
function configuredPriority(event, settings) { return classifyPriority(event, requireSettings(settings)); }
function highestConfiguredPriority(events, settings) {
  const rank = { normal: 0, high: 1, critical: 2 }; let highest = 'normal';
  for (const event of Array.isArray(events) ? events : []) { const current = configuredPriority(event, settings); if (rank[current] > rank[highest]) highest = current; }
  return highest;
}
function selectMentions(roleIds, userIds) {
  const rawRoles = Array.isArray(roleIds) ? roleIds : roleIds == null ? [] : [roleIds]; const roles = []; const seenRoles = new Set();
  for (const raw of rawRoles) { const role = validateDiscordRoleId(raw); if (role !== null && !seenRoles.has(role)) { seenRoles.add(role); roles.push(role); } }
  let length = roles.reduce((total, role, index) => total + (index === 0 ? 0 : 1) + `<@&${role}>`.length, 0); const selected = []; const seen = new Set();
  for (const id of Array.isArray(userIds) ? userIds : []) {
    const valid = validateDiscordUserId(id); if (valid === null || seen.has(valid)) continue;
    const token = `<@${valid}>`; const nextLength = length === 0 ? token.length : length + 1 + token.length; if (nextLength > DISCORD_CONTENT_LIMIT) break;
    seen.add(valid); selected.push(valid); length = nextLength;
  }
  return Array.isArray(roleIds) ? { roleIds: roles, userIds: selected } : { roleId: roles[0] || null, userIds: selected };
}
function buildMentionContent(roleIds, userIds) {
  const selected = selectMentions(roleIds, userIds); const roles = Array.isArray(selected.roleIds) ? selected.roleIds : selected.roleId === null ? [] : [selected.roleId];
  return roles.map((role) => `<@&${role}>`).concat(selected.userIds.map((id) => `<@${id}>`)).join(' ');
}
function buildAllowedMentions(roleIds, userIds) {
  const selected = selectMentions(roleIds, userIds); const mentions = { users: selected.userIds.slice() }; const roles = Array.isArray(selected.roleIds) ? selected.roleIds : selected.roleId === null ? [] : [selected.roleId];
  if (roles.length > 0) mentions.roles = roles.slice(); return mentions;
}
function eventClass(events) {
  const list = Array.isArray(events) ? events : [];
  const attacks = list.some((event) => event && (event.eventType === 'attack' || event.eventType === 'mixed') || discordEventCount(event, 'addedAttackCount') > 0);
  const raids = list.some((event) => event && (event.eventType === 'raid' || event.eventType === 'mixed') || discordEventCount(event, 'addedRaidCount') > 0);
  return attacks ? 'attack' : raids ? 'raid' : 'roster';
}
function playerIdentity(event, sourceIndex) {
  const source = event && typeof event === 'object' ? event : {};
  for (const candidate of [source.playerId, source.profileId, source.id, extractPlayerId(source.url)]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate);
  }
  return `source:${sourceIndex}`;
}
function sortedEntries(events) {
  return events.map((event, sourceIndex) => ({ event, sourceIndex })).sort((left, right) => {
    const rank = eventRank(left.event) - eventRank(right.event); if (rank !== 0) return rank;
    const attacks = discordEventCount(right.event, 'addedAttackCount') - discordEventCount(left.event, 'addedAttackCount'); if (attacks !== 0) return attacks;
    const raids = discordEventCount(right.event, 'addedRaidCount') - discordEventCount(left.event, 'addedRaidCount'); if (raids !== 0) return raids;
    const leftName = String(left.event && left.event.name || ''); const rightName = String(right.event && right.event.name || '');
    return leftName.localeCompare(rightName, 'pl', { sensitivity: 'base' }) || (leftName < rightName ? -1 : rightName < leftName ? 1 : 0) || left.sourceIndex - right.sourceIndex;
  });
}
function aggregate(events) {
  const result = { addedAttackCount: 0, addedRaidCount: 0, attackCount: 0, raidCount: 0, changes: 0 };
  for (const event of Array.isArray(events) ? events : []) {
    if (event && (event.eventType === 'join' || event.eventType === 'leave')) { result.changes += 1; continue; }
    for (const key of ['addedAttackCount', 'addedRaidCount', 'attackCount', 'raidCount']) result[key] += discordEventCount(event, key);
  }
  return result;
}
function buildCompactDiscordTitle(events, settings) {
  const list = Array.isArray(events) ? events : []; const validated = requireSettings(settings); const kind = eventClass(list);
  const prefix = kind === 'attack' ? '🚨 Alliance attack' : kind === 'raid' ? '🛡️ Alliance raid' : '🔄 Alliance changes';
  const playerCount = new Set(list.map(playerIdentity)).size;
  return { text: `${prefix} · ${playerCount} ${playerCount === 1 ? 'player' : 'players'}`, eventClass: kind, playerCount, color: PRIORITY_COLORS[highestConfiguredPriority(list, validated)] };
}
function buildProfileLink(event, context) {
  const source = event && typeof event === 'object' ? event : {}; const name = escapeDiscordMarkdown(truncateText(source.name, EVENT_NAME_MAX));
  return `[${name}](${encodeMarkdownUrl(safeProfileUrl(source.url, context))})`;
}
function buildCompactDiscordPlayerLine(event, context, settings) {
  const source = event && typeof event === 'object' ? event : {}; const name = truncateText(cleanText(source.name) || 'Unknown player', EVENT_NAME_MAX); const link = buildProfileLink({ name, url: source.url }, context);
  if (source.eventType === 'join') return `${link} — joined the alliance`; if (source.eventType === 'leave') return `${link} — left the alliance`;
  const priority = configuredPriority(source, requireSettings(settings)); const attacks = discordEventCount(source, 'addedAttackCount'); const raids = discordEventCount(source, 'addedRaidCount'); const segments = [];
  if (attacks > 0) segments.push(`**+${attacks} ${attackWord(attacks)}**`); if (raids > 0) segments.push(`**+${raids} ${raidWord(raids)}**`);
  const activeAttacks = discordEventCount(source, 'attackCount'); const activeRaids = discordEventCount(source, 'raidCount'); const suffix = priority === 'critical' ? ' · Priority: Critical' : priority === 'high' ? ' · Priority: High' : '';
  return `${link}${segments.length > 0 ? ` — ${segments.join(' · ')}` : ' — no new activity'}\nNow: ${activeAttacks} ${attackWord(activeAttacks)} / ${activeRaids} ${raidWord(activeRaids)}${suffix}`;
}
function priorityLabel(priority) { return priority === 'high' ? 'High' : priority === 'critical' ? 'Critical' : 'Normal'; }
function buildCompactDiscordSummaryFields(events, settings, observedText) {
  const list = Array.isArray(events) ? events : []; const validated = requireSettings(settings); const totals = aggregate(list); const kind = eventClass(list); const parts = [];
  if (kind === 'roster') { const joined = list.filter((event) => event && event.eventType === 'join').length; const left = list.filter((event) => event && event.eventType === 'leave').length; if (joined > 0) parts.push(`**${joined} joined**`); if (left > 0) parts.push(`**${left} left**`); }
  else { if (totals.addedAttackCount > 0) parts.push(`**+${totals.addedAttackCount} ${attackWord(totals.addedAttackCount)}**`); if (totals.addedRaidCount > 0) parts.push(`**+${totals.addedRaidCount} ${raidWord(totals.addedRaidCount)}**`); }
  return [{ name: 'New', value: parts.length > 0 ? parts.join(' · ') : 'No new activity', inline: true }, { name: 'Active now', value: kind === 'roster' ? '—' : `${totals.attackCount} ${attackWord(totals.attackCount)} / ${totals.raidCount} ${raidWord(totals.raidCount)}`, inline: true }, { name: 'Priority', value: priorityLabel(highestConfiguredPriority(list, validated)), inline: true }];
}
function isValidDiscordTime(value) { return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()); }
function buildCompactDiscordTiming(observedAtMs, dispatchedAtMs, approximateObserved = false) {
  const observed = isValidDiscordTime(observedAtMs); const dispatched = isValidDiscordTime(dispatchedAtMs); const timing = { footer: { text: 'Observation time unavailable' } };
  if (!dispatched) return timing; timing.timestamp = new Date(dispatchedAtMs).toISOString(); if (!observed || observedAtMs > dispatchedAtMs) return timing;
  if (approximateObserved === true) { timing.footer.text = 'Approximate observation'; return timing; }
  const elapsed = dispatchedAtMs - observedAtMs; timing.footer.text = elapsed < 1000 ? 'Observed <1s before dispatch' : `Observed ${Math.floor(elapsed / 1000)}s before dispatch`; return timing;
}
function worldHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.trim() === '') throw new TypeError('discord-world-hostname-required');
  const normalized = String(hostname).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (normalized === '') throw new TypeError('discord-world-hostname-invalid'); return truncateText(normalized, 256);
}
function buildCompactDiscordPresentation(events, options) {
  const list = Array.isArray(events) ? events : []; if (list.length === 0) return null;
  const source = options && typeof options === 'object' ? options : {}; const context = source.context && typeof source.context === 'object' ? source.context : {}; const settings = requireSettings(source.settings); const title = buildCompactDiscordTitle(list, settings);
  const timing = buildCompactDiscordTiming(source.observedAtMs, source.dispatchedAtMs, source.approximateObserved === true);
  const presentation = { baseTitle: title.text, eventClass: title.eventClass, allianceUrl: safeAllianceUrl(source.allianceUrl, context), color: title.color, summaryFields: buildCompactDiscordSummaryFields(list, settings, timing.footer.text), lineEntries: sortedEntries(list).map((entry) => ({ ...entry, line: buildCompactDiscordPlayerLine(entry.event, context, settings) })), footer: { text: truncateText(`${worldHostname(source.worldHostname)} · ${timing.footer.text}`, 256) } };
  if (Object.prototype.hasOwnProperty.call(timing, 'timestamp')) presentation.timestamp = timing.timestamp; return presentation;
}
function measureDiscordEmbedText(embeds) {
  let total = 0; for (const embed of Array.isArray(embeds) ? embeds : []) { if (typeof embed.title === 'string') total += embed.title.length; if (typeof embed.description === 'string') total += embed.description.length; for (const field of Array.isArray(embed.fields) ? embed.fields : []) { if (typeof field.name === 'string') total += field.name.length; if (typeof field.value === 'string') total += field.value.length; } if (embed.footer && typeof embed.footer.text === 'string') total += embed.footer.text.length; } return total;
}
function embedGroups(presentation, groups, title) {
  return groups.map((entries, index) => { const embed = { description: `**Players**${entries.length > 0 ? `\n${entries.map((entry) => entry.line).join('\n\n')}` : ''}`, color: presentation.color }; if (index === 0) { embed.title = title; embed.url = presentation.allianceUrl; embed.fields = presentation.summaryFields.map((field) => ({ ...field })); } if (index === groups.length - 1) { embed.footer = { text: presentation.footer.text }; if (Object.prototype.hasOwnProperty.call(presentation, 'timestamp')) embed.timestamp = presentation.timestamp; } return embed; });
}
function requestFits(presentation, groups, title) {
  const embeds = embedGroups(presentation, groups, title); if (embeds.length === 0 || embeds.length > DISCORD_EMBEDS_LIMIT || measureDiscordEmbedText(embeds) > EMBED_TOTAL_TEXT_LIMIT) return false;
  return embeds.every((embed) => (!embed.title || embed.title.length <= 256) && typeof embed.description === 'string' && embed.description.length <= EMBED_DESCRIPTION_LIMIT && (embed.fields || []).every((field) => typeof field.name === 'string' && field.name.length <= 256 && typeof field.value === 'string' && field.value.length <= EMBED_FIELD_VALUE_LIMIT));
}
function partitionCompactDiscordEntries(presentation) {
  if (!presentation || !Array.isArray(presentation.lineEntries) || presentation.lineEntries.length === 0) return [];
  const entries = presentation.lineEntries; const width = String(entries.length).length; const reservedTitle = `${presentation.baseTitle} · part ${'9'.repeat(width)}/${'9'.repeat(width)}`;
  for (const entry of entries) if (`**Players**\n${entry.line}`.length > EMBED_DESCRIPTION_LIMIT || !requestFits(presentation, [[entry]], reservedTitle)) throw new RangeError('discord-row-over-budget');
  if (requestFits(presentation, [entries], presentation.baseTitle)) return [{ requestIndex: 0, embedPlans: [{ lineEntries: entries.slice(), embed: embedGroups(presentation, [entries], presentation.baseTitle)[0] }] }];
  const requests = []; let finalized = []; let current = [];
  const finish = () => { if (current.length > 0) { finalized = finalized.concat([current]); current = []; } if (finalized.length > 0) { requests.push({ groups: finalized }); finalized = []; } };
  for (const entry of entries) { let placed = false; while (!placed) { if (requestFits(presentation, finalized.concat([current.concat([entry])]), reservedTitle)) { current = current.concat([entry]); placed = true; } else if (current.length > 0) { if (finalized.length >= DISCORD_EMBEDS_LIMIT - 1) finish(); else { finalized = finalized.concat([current]); current = []; } } else if (finalized.length > 0) finish(); else throw new RangeError('discord-row-over-budget'); } }
  finish(); const total = requests.length;
  return requests.map((request, requestIndex) => { const title = total > 1 ? `${presentation.baseTitle} · part ${requestIndex + 1}/${total}` : presentation.baseTitle; const embeds = embedGroups(presentation, request.groups, title); return { requestIndex, embedPlans: request.groups.map((lineEntries, index) => ({ lineEntries: lineEntries.slice(), embed: embeds[index] })) }; });
}
function serializePlans(plans, mentions, events) {
  const source = mentions && typeof mentions === 'object' ? mentions : {}; const list = Array.isArray(events) ? events : []; const roles = [];
  if (list.some((event) => event && (event.eventType === 'attack' || event.eventType === 'mixed'))) roles.push(source.roleId); if (list.some((event) => event && event.eventType === 'leave')) roles.push(source.leaveRoleId);
  const users = (Array.isArray(source.userIds) ? source.userIds : []).map((userId, index) => ({ userId, index, score: discordEventCount(list[index], 'addedAttackCount') + discordEventCount(list[index], 'addedRaidCount') })).sort((left, right) => right.score - left.score || left.index - right.index).map((entry) => entry.userId);
  const selected = selectMentions(roles, users); const content = buildMentionContent(selected.roleIds, selected.userIds); const allowed = buildAllowedMentions(selected.roleIds, selected.userIds);
  return plans.map((plan, index) => ({ content: index > 0 ? '' : content, username: 'Travian — attack alarm', embeds: plan.embedPlans.map((item) => item.embed), allowed_mentions: index > 0 ? { users: [] } : { users: allowed.users.slice(), ...(Array.isArray(allowed.roles) ? { roles: allowed.roles.slice() } : {}) } }));
}
function assertLimits(payloads) {
  for (const payload of payloads) { if (typeof payload.content !== 'string' || payload.content.length > DISCORD_CONTENT_LIMIT || !Array.isArray(payload.embeds) || payload.embeds.length > DISCORD_EMBEDS_LIMIT || measureDiscordEmbedText(payload.embeds) > EMBED_TOTAL_TEXT_LIMIT) throw new RangeError('discord-payload-over-budget'); for (const embed of payload.embeds) { if (typeof embed.description !== 'string' || embed.description.length > EMBED_DESCRIPTION_LIMIT || typeof embed.title === 'string' && embed.title.length > 256) throw new RangeError('discord-payload-over-budget'); for (const field of embed.fields || []) if (typeof field.name !== 'string' || field.name.length > 256 || typeof field.value !== 'string' || field.value.length > EMBED_FIELD_VALUE_LIMIT) throw new RangeError('discord-payload-over-budget'); } } return payloads;
}
function buildEventDescriptionLine(event) {
  const source = event && typeof event === 'object' ? event : {}; const name = escapeDiscordMarkdown(truncateText(source.name || 'Unknown player', EVENT_NAME_MAX));
  if (source.eventType === 'join') return `${name} — joined the alliance`; if (source.eventType === 'leave') return `${name} — left the alliance`;
  const attacks = discordEventCount(source, 'attackCount'); const raids = discordEventCount(source, 'raidCount'); const addedAttacks = discordEventCount(source, 'addedAttackCount'); const addedRaids = discordEventCount(source, 'addedRaidCount');
  return `${name} — +${addedAttacks} ${attackWord(addedAttacks)} · +${addedRaids} ${raidWord(addedRaids)} (${attacks} ${attackWord(attacks)} / ${raids} ${raidWord(raids)} active)`;
}
function chunkEventsForDiscord(events, maxSize, budget, estimate) {
  if (!Array.isArray(events)) return []; const size = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize >= 1 ? Math.floor(maxSize) : PAYLOAD_CHUNK_MAX; const limit = typeof budget === 'number' && Number.isFinite(budget) && budget >= 1 ? Math.floor(budget) : EMBED_DESCRIPTION_SAFE_BUDGET; const estimator = typeof estimate === 'function' ? estimate : (event) => buildEventDescriptionLine(event).length;
  const chunks = []; let current = []; let cost = 0; for (const event of events) { if (current.length > 0 && (current.length >= size || cost + estimator(event, current.length + 1) > limit)) { chunks.push(current); current = []; cost = 0; } current.push(event); cost += estimator(event, current.length); } if (current.length > 0) chunks.push(current); return chunks;
}
function buildDiscordPayloads(events, options = {}) {
  const sourceEvents = Array.isArray(events) ? events.slice() : []; if (sourceEvents.length === 0) return []; const sorted = sortedEntries(sourceEvents).map((entry) => entry.event); const context = options.context && typeof options.context === 'object' ? options.context : {};
  const observedAtMs = Number.isFinite(options.observedAtMs) ? options.observedAtMs : sorted.reduce((earliest, event) => Number.isFinite(event && event.observedAtMs) ? Math.min(earliest, event.observedAtMs) : earliest, Infinity);
  const dispatchedAtMs = Number.isFinite(options.dispatchedAtMs) ? options.dispatchedAtMs : sorted.reduce((latest, event) => Number.isFinite(event && event.dispatchedAtMs) ? Math.max(latest, event.dispatchedAtMs) : latest, -Infinity);
  const presentation = buildCompactDiscordPresentation(sourceEvents, { allianceUrl: options.allianceUrl, context, worldHostname: options.worldHostname, settings: options.settings, approximateObserved: options.approximateObserved === true || sorted.some((event) => event && (event.approximateObserved === true || event.observedAtApproximate === true)), observedAtMs, dispatchedAtMs });
  return assertLimits(serializePlans(partitionCompactDiscordEntries(presentation), { roleId: options.roleId, leaveRoleId: options.leaveRoleId, userIds: options.userIds }, sourceEvents));
}

module.exports = { filterMutedEvents, buildMentionContent, buildAllowedMentions, buildCompactDiscordTitle, buildCompactDiscordPlayerLine, buildCompactDiscordSummaryFields, buildCompactDiscordTiming, buildCompactDiscordPresentation, isValidDiscordTime, measureDiscordEmbedText, partitionCompactDiscordEntries, selectMentions, buildEventDescriptionLine, buildDiscordPayloads, buildProfileLink, chunkEventsForDiscord };
