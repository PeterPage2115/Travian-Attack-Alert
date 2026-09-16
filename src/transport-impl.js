'use strict';

const adapters = require('./adapters.js');
const { MAX_ATTEMPT_COUNT, MAX_RETRY_DELAY_MS, REQUEST_TIMEOUT_MS, RETRY_DELAY_MS } = require('./constants.js');
const { validateWebhookUrl } = require('./text.js');

let activeClock = adapters.createClockAdapter({});

function configureTransportAdapters(seam) {
  const source = seam && typeof seam === 'object' ? seam : {};
  if (Object.prototype.hasOwnProperty.call(source, 'clock')) activeClock = adapters.createClockAdapter(source.clock || {});
}

function resetTransportAdapters() { activeClock = adapters.createClockAdapter({}); }

function isRetryableOutcome(status, errorClass) {
  if (status === null) return errorClass === 'network' || errorClass === 'timeout' || errorClass === 'abort';
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}

function parseRetryAfterMs(response) {
  if (!response || typeof response !== 'object') return null;
  try {
    const body = JSON.parse(String(response.responseText || ''));
    const value = body && typeof body === 'object' ? body.retry_after : undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value * 1000);
  } catch (error) {}
  const headerText = typeof response.responseHeaders === 'string' ? response.responseHeaders : '';
  for (const line of headerText.split(/\r?\n/u)) {
    const separatorIndex = line.indexOf(':'); if (separatorIndex === -1) continue;
    if (line.slice(0, separatorIndex).trim().toLowerCase() !== 'retry-after') continue;
    const raw = line.slice(separatorIndex + 1).trim(); const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - activeClock.now());
  }
  return null;
}

function sanitizeRetryDelay(retryAfterMs, fallback) {
  const base = Number.isFinite(retryAfterMs) ? retryAfterMs : NaN;
  if (Number.isNaN(base) || base < 0) return Number.isFinite(fallback) ? fallback : 1000;
  return Math.min(MAX_RETRY_DELAY_MS, Math.floor(base));
}

function buildDiscordRequestUrl(canonicalWebhookUrl) {
  const validated = validateWebhookUrl(canonicalWebhookUrl); if (validated === null) return null;
  const requestUrl = new URL(validated); requestUrl.searchParams.set('wait', 'true'); return requestUrl.href;
}

function classifyDiscordResponse(response) {
  const input = response && typeof response === 'object' ? response : {};
  const status = Number.isInteger(input.status) ? input.status : null;
  if (status === 200) {
    try {
      const body = JSON.parse(String(input.responseText || ''));
      return body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' && body.id.length > 0
        ? { kind: 'acknowledged', messageId: body.id }
        : { kind: 'uncertain', responseClass: 'malformed-json-200' };
    } catch (error) { return { kind: 'uncertain', responseClass: 'non-json-200' }; }
  }
  if (status === null && isRetryableOutcome(status, input.errorClass)) return { kind: 'retryable', errorClass: input.errorClass };
  if (isRetryableOutcome(status, input.errorClass)) return { kind: 'retryable', status, retryAfterMs: parseRetryAfterMs(input) };
  return { kind: 'permanent', status, responseClass: status === null ? String(input.errorClass || 'unknown') : undefined };
}

function sendDiscordPayload(options = {}) {
  const requestUrl = buildDiscordRequestUrl(options.webhookUrl);
  if (requestUrl === null || typeof options.gmRequest !== 'function') return Promise.resolve({ kind: 'permanent', responseClass: 'configuration' });
  const request = adapters.createGmRequestAdapter({ gmRequest: options.gmRequest });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (response) => { if (settled) return; settled = true; resolve(classifyDiscordResponse(response)); };
    try {
      request.request({
        method: 'POST', url: requestUrl,
        timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(options.payload || {}),
        onload: settle,
        onerror: (error) => settle({ status: null, errorClass: 'network', error }),
        ontimeout: () => settle({ status: null, errorClass: 'timeout' }),
        onabort: () => settle({ status: null, errorClass: 'abort' }),
      });
    } catch (error) { settle({ status: null, errorClass: 'network', error }); }
  });
}

async function sendDiscordPayloadWithRetry(options = {}) {
  const maxAttempts = Math.min(MAX_ATTEMPT_COUNT, Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : MAX_ATTEMPT_COUNT);
  const sleep = typeof options.sleep === 'function' ? options.sleep : async () => {};
  let attempts = 0; const delays = []; let outcome;
  do {
    if (typeof options.fence === 'function' && options.fence('before-attempt') !== true) return { outcome: { kind: 'fenced' }, attempts, delays };
    attempts += 1; outcome = await sendDiscordPayload(options);
    if (typeof options.fence === 'function' && options.fence('after-response') !== true) return { outcome: { kind: 'fenced' }, attempts, delays };
    if (outcome.kind !== 'retryable' || attempts >= maxAttempts) break;
    const delay = sanitizeRetryDelay(outcome.retryAfterMs, RETRY_DELAY_MS[attempts - 1] || 1000);
    delays.push(delay); await sleep(delay);
    if (typeof options.fence === 'function' && options.fence('before-retry') !== true) return { outcome: { kind: 'fenced' }, attempts, delays };
  } while (attempts < maxAttempts);
  return { outcome, attempts, delays };
}

module.exports = {
  configureTransportAdapters, resetTransportAdapters,
  isRetryableOutcome, parseRetryAfterMs, sanitizeRetryDelay,
  buildDiscordRequestUrl, classifyDiscordResponse,
  sendDiscordPayload, sendDiscordPayloadWithRetry,
};
