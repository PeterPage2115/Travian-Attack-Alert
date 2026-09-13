'use strict';

/** Pure text, URL, validation, and diagnostic sanitization contracts. */
const EVENT_URL_MAX = 300;
const MAX_DIAGNOSTIC_LOG_LENGTH = 320;

function truncateText(value, maxLength) {
    const text = String(value || '');
    const max = typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 0;
    if (text.length <= max) return text;
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(segmenter.segment(text)).slice(0, max).map(segment => segment.segment).join('');
    }
    return Array.from(text).slice(0, max).join('');
}
function encodeMarkdownUrl(url) { return String(url || '').replace(/([\\()\s<>])/g, '\\$1'); }
function safeProfileUrl(url, context) {
    const source = context && typeof context === 'object' ? context : {};
    const origin = typeof source.origin === 'string' && source.origin !== '' ? source.origin : null;
    const fallbackHref = typeof source.fallbackHref === 'string' && source.fallbackHref !== '' ? source.fallbackHref : null;
    let trustedFallback = null;
    if (fallbackHref !== null && origin !== null) {
        try { const parsed = new URL(fallbackHref, origin); if (parsed.origin === origin) trustedFallback = truncateText(parsed.href, EVENT_URL_MAX); } catch {}
    }
    const raw = typeof url === 'string' ? url : '';
    if (raw.trim() === '') return trustedFallback !== null ? trustedFallback : '';
    let parsed = null;
    if (origin !== null) { try { parsed = new URL(raw, origin); } catch {} }
    return parsed !== null && parsed.origin === origin ? truncateText(parsed.href, EVENT_URL_MAX) : (trustedFallback !== null ? trustedFallback : '');
}
function safeAllianceUrl(allianceUrl, context) {
    const source = context && typeof context === 'object' ? context : {};
    let trustedOrigin = null;
    if (typeof source.origin === 'string' && source.origin !== '') {
        try { const parsed = new URL(source.origin); if (parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password) trustedOrigin = parsed.origin; } catch {}
    }
    if (trustedOrigin === null) throw new TypeError('discord-alliance-url-unavailable');
    const validate = value => {
        if (typeof value !== 'string' || value === '') return null;
        try { const parsed = new URL(value, trustedOrigin); return parsed.protocol === 'https:' && parsed.origin === trustedOrigin && !parsed.username && !parsed.password && parsed.href.length <= 2048 ? parsed.href : null; } catch { return null; }
    };
    const candidate = validate(allianceUrl); if (candidate !== null) return candidate;
    const fallback = validate(source.fallbackHref); if (fallback !== null) return fallback;
    throw new TypeError('discord-alliance-url-unavailable');
}
function validateWebhookUrl(input) {
    if (typeof input !== 'string' || input.trim() === '') return null;
    let parsed; try { parsed = new URL(input.trim()); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'discord.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
    const match = parsed.pathname.match(/^\/api\/webhooks\/(\d+)\/([^/]+)$/);
    return match && match[2].trim() !== '' ? parsed.href : null;
}
function parseDiscordSnowflake(input) { return typeof input === 'string' && /^\d{17,20}$/.test(input.trim()) ? input.trim() : null; }
function validateDiscordUserId(input) { return parseDiscordSnowflake(input); }
function validateDiscordRoleId(input) { return parseDiscordSnowflake(input); }
function extractPlayerId(url) {
    if (typeof url !== 'string' || url.length === 0 || url.includes('/alliance/')) return null;
    for (const pattern of [/\/profile\/(\d+)/i, /\/player\/(\d+)/i, /spieler\.php\?[^#]*uid=(\d+)/i, /uid=(\d+)/i]) {
        const match = url.match(pattern); if (match) return match[1];
    }
    return null;
}
function normalizeProfileInput(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim(); if (trimmed.length === 0) return null;
    return /^\d+$/.test(trimmed) ? trimmed : extractPlayerId(input);
}
function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function extractNameFromProfileHtml(html) {
    const match = String(html || '').match(/<h1[^>]*class="[^"]*titleInHeader[^"]*"[^>]*>([^<]+)<\/h1>/i);
    let name = match ? match[1] : null;
    if (name !== null) name = name.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (full, entity) => {
        const lower = entity.toLowerCase();
        if (lower === 'amp') return '&'; if (lower === 'lt') return '<'; if (lower === 'gt') return '>';
        if (lower === 'quot') return '"'; if (lower === 'apos') return "'";
        const number = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return Number.isFinite(number) && number >= 0 && number <= 1114111 ? String.fromCodePoint(number) : full;
    });
    return cleanText(name) || null;
}
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu;
function stripUnsafe(value) { return String(value === undefined || value === null ? '' : value).replace(UNSAFE, ''); }
function sanitizeDiagnosticText(value) { return stripUnsafe(value).replace(/https?:\/\/[^\s]+/gi, '[url]').replace(/(?:webhook|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').replace(/\b\d{4,}\b/g, '[id]').slice(0, MAX_DIAGNOSTIC_LOG_LENGTH); }
function sanitizeDiagnosticsExport(value, seen = new Set()) {
    if (value === null || value === undefined || typeof value !== 'object') return typeof value === 'string' ? sanitizeDiagnosticText(value) : value;
    if (seen.has(value)) return '[cycle]'; seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticsExport(item, seen));
    const output = {};
    for (const [key, item] of Object.entries(value)) { const safeKey = stripUnsafe(key); output[safeKey] = /webhook|token|secret|url|body|response/i.test(key) ? '[redacted]' : sanitizeDiagnosticsExport(item, seen); }
    return output;
}
function diagnosticString(value, limit) {
    let text = String(value === undefined || value === null ? '' : value);
    text = text.replace(/[\uD800-\uDFFF]/g, (unit, index, source) => { const code = unit.charCodeAt(0); const next = source.charCodeAt(index + 1); const previous = source.charCodeAt(index - 1); if (code >= 55296 && code <= 56319 && next >= 56320 && next <= 57343 || code >= 56320 && code <= 57343 && previous >= 55296 && previous <= 56319) return unit; return '�'; }).normalize('NFC');
    return Array.from(text).slice(0, limit === 64 ? 64 : 320).join('');
}
function canonicalSerializeDiagnostics(value) {
    const transform = (item, seen, keyName) => {
        if (typeof item === 'string') return diagnosticString(item, keyName === 'reason' ? 64 : 320);
        if (typeof item === 'number') return Number.isFinite(item) ? Object.is(item, -0) ? 0 : item : null;
        if (item === null || typeof item === 'boolean') return item;
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || typeof item !== 'object') return undefined;
        if (Object.prototype.toString.call(item) !== '[object Object]' && !Array.isArray(item)) return undefined;
        if (seen.has(item)) throw new TypeError('diagnostic cycle'); seen.add(item);
        if (Array.isArray(item)) { const result = item.map(child => { const value2 = transform(child, seen, ''); return value2 === undefined ? null : value2; }); seen.delete(item); return result; }
        const result = {}; const entries = Object.keys(item).map(key => ({ original: key, normalized: diagnosticString(key, 320) }));
        if (new Set(entries.map(entry => entry.normalized)).size !== entries.length) throw new TypeError('duplicate normalized diagnostic key');
        entries.sort((left, right) => left.normalized < right.normalized ? -1 : left.normalized > right.normalized ? 1 : 0);
        for (const entry of entries) { const value2 = transform(item[entry.original], seen, entry.normalized); if (value2 !== undefined) result[entry.normalized] = value2; }
        seen.delete(item); return result;
    };
    const result = transform(value, new Set(), ''); return JSON.stringify(result === undefined ? null : result);
}
const canonicalSerializeDiagnosticValue = canonicalSerializeDiagnostics;
function diagnosticByteLength(value) { const serialized = typeof value === 'string' ? value : canonicalSerializeDiagnostics(value); return typeof TextEncoder === 'function' ? new TextEncoder().encode(serialized).byteLength : unescape(encodeURIComponent(serialized)).length; }
function raidWord(count) { return count === 1 ? 'raid' : 'raids'; }
module.exports = { truncateText, encodeMarkdownUrl, safeProfileUrl, safeAllianceUrl, validateDiscordUserId, validateDiscordRoleId, validateWebhookUrl, sanitizeDiagnosticText, sanitizeDiagnosticsExport, canonicalSerializeDiagnostics, canonicalSerializeDiagnosticValue, diagnosticByteLength, extractPlayerId, extractNameFromProfileHtml, normalizeProfileInput, raidWord };
