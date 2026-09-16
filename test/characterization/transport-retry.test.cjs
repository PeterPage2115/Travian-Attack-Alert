'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const runtime = require(path.join(SRC, 'runtime.js'));
const impl = require(path.join(SRC, 'transport-impl.js'));
const transport = require(path.join(SRC, 'transport.js'));

const CONTRACT = [
  'isRetryableOutcome', 'parseRetryAfterMs', 'sanitizeRetryDelay',
  'buildDiscordRequestUrl', 'classifyDiscordResponse',
  'sendDiscordPayload', 'sendDiscordPayloadWithRetry',
];
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/fake-token';

test('transport source exposes exactly the 7-symbol contract without runtime-api', () => {
  assert.deepEqual(Object.keys(transport).sort(), [...CONTRACT].sort());
  assert.equal(Object.keys(transport).length, 7);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, 'transport.js'), 'utf8'), /runtime-api/u);
});

test('retryability preserves network states and retryable HTTP ranges', () => {
  for (const fixture of [[null, 'network'], [null, 'timeout'], [null, 'abort'], [null, 'other'], [408], [429], [500], [599], [404], [600]]) {
    assert.equal(impl.isRetryableOutcome(...fixture), runtime.isRetryableOutcome(...fixture));
  }
});

test('retry-after parsing preserves JSON seconds and header seconds', () => {
  const fixtures = [
    { responseText: '{"retry_after":1.25}' },
    { responseText: '{}', responseHeaders: 'Retry-After: 3\r\nContent-Type: text/plain' },
    { responseText: 'not-json', responseHeaders: '' },
  ];
  for (const fixture of fixtures) assert.equal(impl.parseRetryAfterMs(fixture), runtime.parseRetryAfterMs(fixture));
});

test('retry delay preserves fallback, floor, zero, and maximum cap', () => {
  for (const fixture of [[null, 1000], [-1, 3000], [0, 1000], [1234.9, 1000], [3600000, 1000]]) {
    assert.equal(impl.sanitizeRetryDelay(...fixture), runtime.sanitizeRetryDelay(...fixture));
  }
});

test('request URL validation preserves Discord origin and wait=true query', () => {
  assert.equal(impl.buildDiscordRequestUrl(WEBHOOK), runtime.buildDiscordRequestUrl(WEBHOOK));
  assert.equal(new URL(impl.buildDiscordRequestUrl(WEBHOOK)).searchParams.get('wait'), 'true');
  assert.equal(impl.buildDiscordRequestUrl('https://example.test/hook'), null);
});

test('response classification preserves acknowledged, uncertain, retryable, and permanent states', () => {
  const fixtures = [
    { status: 200, responseText: '{"id":"message-1"}' },
    { status: 200, responseText: '{}' },
    { status: 200, responseText: 'bad' },
    { status: 429, responseText: '{"retry_after":1}' },
    { status: 503, responseText: '{}' },
    { status: 404, responseText: '{}' },
    { status: null, errorClass: 'timeout' },
  ];
  for (const fixture of fixtures) assert.deepEqual(impl.classifyDiscordResponse(fixture), runtime.classifyDiscordResponse(fixture));
});

test('send maps GM load, network, timeout, abort, and throw callbacks once', async () => {
  const scenarios = [
    [(details) => details.onload({ status: 200, responseText: '{"id":"m1"}' }), 'acknowledged'],
    [(details) => details.onerror(new Error('network')), 'retryable'],
    [(details) => details.ontimeout(), 'retryable'],
    [(details) => details.onabort(), 'retryable'],
    [() => { throw new Error('network'); }, 'retryable'],
  ];
  for (const [gmRequest, kind] of scenarios) {
    const outcome = await impl.sendDiscordPayload({ webhookUrl: WEBHOOK, payload: { content: 'probe' }, gmRequest });
    assert.equal(outcome.kind, kind);
  }
  assert.deepEqual(await impl.sendDiscordPayload({ webhookUrl: 'bad', payload: {} }), { kind: 'permanent', responseClass: 'configuration' });
});

test('429 then acknowledgement preserves attempts, delays, and payload bytes', async () => {
  const calls = [];
  const sleeps = [];
  const outcome = await impl.sendDiscordPayloadWithRetry({
    webhookUrl: WEBHOOK,
    payload: { content: 'Żółć 😀' },
    gmRequest(details) {
      calls.push(JSON.parse(details.data));
      if (calls.length === 1) details.onload({ status: 429, responseText: '{"retry_after":1}' });
      else details.onload({ status: 200, responseText: '{"id":"m2"}' });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(outcome, { outcome: { kind: 'acknowledged', messageId: 'm2' }, attempts: 2, delays: [1000] });
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(calls, [{ content: 'Żółć 😀' }, { content: 'Żółć 😀' }]);
});

test('persistent retryable failure stops at three attempts with frozen delays', async () => {
  let attempts = 0;
  const outcome = await impl.sendDiscordPayloadWithRetry({
    webhookUrl: WEBHOOK,
    gmRequest(details) { attempts += 1; details.onload({ status: 503, responseText: '{}' }); },
    sleep: async () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(outcome.delays, [1000, 3000]);
  assert.equal(outcome.outcome.kind, 'retryable');
});

test('404 and malformed 200 are single-attempt permanent or uncertain outcomes', async () => {
  for (const response of [{ status: 404, responseText: '{}' }, { status: 200, responseText: '{}' }]) {
    let attempts = 0;
    const outcome = await impl.sendDiscordPayloadWithRetry({
      webhookUrl: WEBHOOK,
      gmRequest(details) { attempts += 1; details.onload(response); },
      sleep: async () => assert.fail('must not sleep'),
    });
    assert.equal(attempts, 1);
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.delays, []);
  }
});

test('fence rejection preserves before-attempt, after-response, and before-retry states', async () => {
  const before = await impl.sendDiscordPayloadWithRetry({ webhookUrl: WEBHOOK, fence: () => false });
  assert.deepEqual(before, { outcome: { kind: 'fenced' }, attempts: 0, delays: [] });
  const stages = [];
  const after = await impl.sendDiscordPayloadWithRetry({
    webhookUrl: WEBHOOK,
    gmRequest(details) { details.onload({ status: 503, responseText: '{}' }); },
    sleep: async () => {},
    fence(stage) { stages.push(stage); return stage !== 'after-response'; },
  });
  assert.deepEqual(after, { outcome: { kind: 'fenced' }, attempts: 1, delays: [] });
  assert.deepEqual(stages, ['before-attempt', 'after-response']);
});
