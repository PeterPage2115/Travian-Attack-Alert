'use strict';

// Contract test for task 4 of .omo/plans/visual-functional-evolution.md:
// README recovery/operations prose must agree with the generated dist runtime.
//
// Version-parameterized by design: the current version and release ID are
// derived from package.json, never hardcoded, so the public 1.0.0 identity
// (or any later bump) keeps this contract green without edits here.
// Historical version tokens (e.g. a "5.2.6-era ... historical" line) are
// allowed only when labelled historical on the same line.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const architecture = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf8');
const operations = fs.readFileSync(path.join(ROOT, 'docs', 'OPERATIONS.md'), 'utf8');
const operationsPl = fs.readFileSync(path.join(ROOT, 'docs', 'pl', 'OPERATIONS.md'), 'utf8');
const runtime = fs.readFileSync(path.join(ROOT, 'dist', 'travian-attack-alert.user.js'), 'utf8');
const runtimeApiSource = fs.readFileSync(path.join(ROOT, 'src', 'runtime-api.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const userscriptConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'userscript.json'), 'utf8'));

const VERSION = String(pkg.version);
const RELEASE_ID = `taa-${VERSION}`;

// The update/download channel is a long-lived branch name
// (`release/public-1.0.0`): its embedded token identifies the channel, not the
// artifact version, so the configured URLs and the branch path are exempt from
// the historical-label rule below.
const RELEASE_CHANNEL_TOKENS = [...new Set(
  [userscriptConfig.updateURL, userscriptConfig.downloadURL]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .flatMap((url) => {
      const branchPath = /\/release\/[^/]+\//.exec(url)?.[0];
      return branchPath ? [url, branchPath, branchPath.slice(0, -1), branchPath.slice(1, -1)] : [url];
    }),
)];

assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'package.json version must be semver');

const EXPECTED_TABS = ['overview', 'players', 'alerts', 'diagnostics'];

// Post-extraction module graph (plan task 20): the 13 domain facades that
// src/runtime-api.js aggregates reference-equal with no select() indirection.
const EXPECTED_DOMAINS = [
  'storage', 'lease', 'parser', 'snapshot', 'envelope', 'migration',
  'discord', 'transport', 'dispatch', 'conservation', 'diagnostics',
  'panel', 'acquisition',
];

const EXPECTED_ADAPTERS = [
  'createStorageAdapter', 'createClockAdapter', 'createSleepAdapter',
  'createGmRequestAdapter', 'createDocumentLocationAdapter',
  'createWebLocksAdapter', 'createSessionStorageAdapter',
];

// Stale pre-cutover claims: the select() indirection was removed, so docs
// must never present contract selection through runtime-api as current.
const STALE_SELECT_PATTERNS = [
  /selektor\w* kontraktu przez [`'"]?runtime-api/i,
  /select (their|the) contract through [`'"]?[^`'"]*runtime-api/i,
  /contract selectors? (via|through) [`'"]?runtime-api/i,
];

// Recovery menu labels that must exist as Tampermonkey menu commands.
const MENU_LABELS = [
  'Set Discord webhook URL',
  'Clear Discord webhook URL',
  'Show Discord webhook status',
  'Retry failed Discord batches',
  'Retry uncertain Discord batches',
  'Mark uncertain Discord batches delivered',
  'Flush pending Discord batches',
  'Toggle debug details',
  'Load history and health',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('readme-runtime contract (Panel vs menu recovery boundary)', () => {
  it('derives one current version/release ID shared by package, runtime, and docs', () => {
    assert.ok(
      runtime.includes(`const RELEASE_VERSION = "${VERSION}"`),
      `dist must declare RELEASE_VERSION "${VERSION}"`,
    );
    assert.ok(
      runtime.includes(`const RELEASE_ID = "${RELEASE_ID}"`),
      `dist must declare RELEASE_ID "${RELEASE_ID}"`,
    );
    assert.ok(
      runtime.includes(`// @version      ${VERSION}`),
      `dist userscript header must carry version ${VERSION}`,
    );
    assert.ok(
      readme.includes(RELEASE_ID),
      `README must identify the runtime as release ID ${RELEASE_ID}`,
    );
    assert.ok(
      readme.includes(VERSION),
      `README must name the current version ${VERSION}`,
    );
  });

  it('keeps exactly four tabs in runtime and docs, with agreeing IDs', () => {
    const tabsDecl = new RegExp(
      `const tabs = \\[${EXPECTED_TABS.map((tab) => `"${tab}"`).join(', ')}\\]`,
    );
    assert.match(runtime, tabsDecl, 'runtime tab array must list exactly the four tabs');
    assert.ok(
      runtime.includes('"taa-tab-" + tab'),
      'runtime must build tab IDs as taa-tab-<name>',
    );
    for (const tab of EXPECTED_TABS) {
      assert.ok(
        readme.includes(`taa-tab-${tab}`),
        `README must document the exact runtime tab ID taa-tab-${tab}`,
      );
    }
    const documented = new Set(
      [...readme.matchAll(/taa-tab-([a-z]+)/g)].map((match) => match[1]),
    );
    assert.deepEqual(
      [...documented].sort(),
      [...EXPECTED_TABS].sort(),
      'README must document exactly four taa-tab-* IDs (no fifth tab)',
    );
  });

  it('documents the incident/settings export IDs present in runtime', () => {
    for (const id of ['taa-incident-bundle-export', 'taa-settings-details']) {
      assert.ok(
        runtime.includes(`"${id}"`),
        `dist must contain the runtime ID "${id}"`,
      );
      assert.ok(
        readme.includes(id),
        `README must document the runtime ID "${id}"`,
      );
    }
    for (const id of ['taa-settings-export', 'taa-settings-import']) {
      assert.ok(
        runtime.includes(`"${id}"`),
        `dist must contain the runtime ID "${id}"`,
      );
    }
  });

  it('registers webhook/retry/flush/debug menu labels in runtime', () => {
    for (const label of MENU_LABELS) {
      assert.ok(
        runtime.includes(`GM_registerMenuCommand(\n            "${label}"`) ||
          runtime.includes(`GM_registerMenuCommand("${label}"`) ||
          new RegExp(`GM_registerMenuCommand\\(\\s*"${escapeRegExp(label)}"`).test(runtime),
        `dist must register the Tampermonkey menu command "${label}"`,
      );
    }
  });

  it('names the recovery menu labels in docs (webhook/retry/flush/debug)', () => {
    for (const label of [
      'Set Discord webhook URL',
      'Retry failed Discord batches',
      'Flush pending Discord batches',
      'Toggle debug details',
    ]) {
      assert.ok(
        readme.includes(label),
        `README must name the Tampermonkey menu command "${label}" so operators find it`,
      );
    }
    assert.match(
      readme,
      /Tampermonkey menu[^.]{0,300}(retry|flush|debug|webhook)/i,
      'README must attribute retry/flush/debug/webhook work to the Tampermonkey menu',
    );
  });

  it('never presents recovery mutations as Panel controls', () => {
    const forbidden = [
      /the panel exposes[^.]*(retry|webhook|flush|debug)/i,
      /use the panel or Tampermonkey menu to configure the attack webhook/i,
      /Export diagnostics/,
      /panel[^.]*(Retry failed|Flush pending|Mark uncertain|Toggle debug)/,
    ];
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(readme),
        `README must not contain the false panel-location claim ${pattern}`,
      );
    }
  });

  it('preserves export-first ordering and site-data-preservation guidance', () => {
    assert.match(
      readme,
      /export incident bundle[\s\S]{0,80}first|first[\s\S]{0,80}export incident bundle/i,
      'README must order the incident bundle export first',
    );
    assert.match(
      readme,
      /do not (clear site data|delete storage)|never clear site data/i,
      'README must warn that clearing site data/storage destroys recoverable copies',
    );
  });

  it('distinguishes the incident bundle from the settings backup', () => {
    assert.match(readme, /incident bundle/i, 'README must describe the incident bundle');
    assert.match(readme, /settings backup/i, 'README must describe the settings backup');
    assert.match(
      readme,
      /bounded[\s\S]{0,120}redact|redact[\s\S]{0,120}bounded/i,
      'README must describe the incident bundle as bounded and redacted',
    );
    assert.match(
      readme,
      /settings backup[\s\S]{0,200}restore|restore[\s\S]{0,200}settings backup/i,
      'README must describe the settings backup as the full-settings restore path',
    );
  });

  it('labels every non-current version token as historical', () => {
    const lines = readme.split('\n');
    const bad = [];
    lines.forEach((line, index) => {
      const scanned = RELEASE_CHANNEL_TOKENS.reduce((text, token) => text.split(token).join('<release-channel>'), line);
      for (const match of scanned.matchAll(/\b\d+\.\d+\.\d+\b/g)) {
        if (match[0] === VERSION) continue;
        if (/historical/i.test(line)) continue;
        bad.push(`line ${index + 1}: "${match[0]}" without a historical label`);
      }
      for (const match of scanned.matchAll(/\btaa-\d+\.\d+\.\d+\b/g)) {
        if (match[0] === RELEASE_ID) continue;
        if (/historical/i.test(line)) continue;
        bad.push(`line ${index + 1}: "${match[0]}" without a historical label`);
      }
    });
    assert.deepEqual(bad, [], 'non-current versions must be labelled historical, never current contract');
  });

  it('exposes no real webhook secret in docs', () => {
    const suspicious = [...readme.matchAll(/discord\.com\/api\/webhooks\/\d+\/([A-Za-z0-9_-]+)/g)]
      .map((match) => match[1])
      .filter((token) => !/^(<[^>]*>|FAKE|PLACEHOLDER|example)$/i.test(token));
    assert.deepEqual(suspicious, [], 'README must not contain a real webhook token');
  });
});

describe('readme-runtime contract (post-extraction module graph)', () => {
  it('aggregates exactly the 13 domain facades with no select() indirection', () => {
    const api = require(path.join(ROOT, 'src', 'runtime-api.js'));
    assert.deepEqual(Object.keys(api).sort(), [...EXPECTED_DOMAINS].sort());
    assert.equal(typeof api.select, 'undefined', 'runtime-api.select must stay removed');
    assert.doesNotMatch(runtimeApiSource, /function select\(/);
    assert.ok(
      !runtimeApiSource.includes("require('./runtime.js')") &&
        !runtimeApiSource.includes('require("./runtime.js")'),
      'runtime-api must not depend on the legacy authority',
    );
    for (const domain of EXPECTED_DOMAINS) {
      const facade = require(path.join(ROOT, 'src', `${domain}.js`));
      assert.equal(api[domain], facade, `runtime-api.${domain} must be the facade itself`);
    }
  });

  it('owns lifecycle state and adapters behind the fixed seams', () => {
    const lifecycle = require(path.join(ROOT, 'src', 'lifecycle.js'));
    assert.deepEqual(Object.keys(lifecycle), ['createLifecycleController']);
    const adapters = require(path.join(ROOT, 'src', 'adapters.js'));
    assert.deepEqual(Object.keys(adapters).sort(), [...EXPECTED_ADAPTERS].sort());
  });

  it('documents the 13 domains, lifecycle, adapters, and aggregator in README', () => {
    for (const domain of EXPECTED_DOMAINS) {
      assert.ok(readme.includes(`\`${domain}\``), `README must name the domain module \`${domain}\``);
    }
    for (const token of ['src/lifecycle.js', 'src/adapters.js', 'src/runtime-api.js', 'src/runtime.js']) {
      assert.ok(readme.includes(token), `README must reference ${token}`);
    }
    assert.match(readme, /no [`']?select\(\)[`']? indirection/, 'README must state the select() indirection is gone');
    assert.match(readme, /aggregator/, 'README must name the aggregator pattern');
  });

  it('documents the post-extraction graph in AGENTS.md and architecture.md', () => {
    for (const doc of [agents, architecture]) {
      for (const domain of EXPECTED_DOMAINS) {
        assert.ok(doc.includes(domain), 'module docs must name every domain module');
      }
      for (const token of ['lifecycle.js', 'adapters.js', 'runtime-api.js', 'runtime.js']) {
        assert.ok(doc.includes(token), `module docs must reference ${token}`);
      }
    }
    assert.match(agents, /agregator/i, 'AGENTS.md must name the aggregator pattern');
    assert.match(architecture, /aggregator/, 'architecture.md must name the aggregator pattern');
    assert.match(architecture, /createLifecycleController/, 'architecture.md must name the lifecycle owner');
    for (const factory of EXPECTED_ADAPTERS) {
      assert.ok(architecture.includes(factory), `architecture.md must name the adapter factory ${factory}`);
    }
  });

  it('maps the implementation in both operations pages without stale claims', () => {
    for (const [label, doc] of [['OPERATIONS.md', operations], ['pl/OPERATIONS.md', operationsPl]]) {
      assert.ok(doc.includes('src/runtime-api.js'), `${label} must reference the aggregator`);
      assert.ok(doc.includes('src/lifecycle.js'), `${label} must reference the lifecycle owner`);
      assert.ok(doc.includes('src/adapters.js'), `${label} must reference the adapter seam`);
    }
    for (const [label, doc] of [
      ['README.md', readme], ['AGENTS.md', agents],
      ['docs/architecture.md', architecture],
      ['docs/OPERATIONS.md', operations], ['docs/pl/OPERATIONS.md', operationsPl],
    ]) {
      for (const pattern of STALE_SELECT_PATTERNS) {
        assert.ok(!pattern.test(doc), `${label} must not contain the stale select-indirection claim ${pattern}`);
      }
    }
  });
});
