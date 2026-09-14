'use strict';

// Contract test for task 4 of .omo/plans/visual-functional-evolution.md:
// README recovery/operations prose must agree with the script.txt runtime.
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
const runtime = fs.readFileSync(path.join(ROOT, 'dist', 'travian-attack-alert.user.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const VERSION = String(pkg.version);
const RELEASE_ID = `taa-${VERSION}`;

assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'package.json version must be semver');

const EXPECTED_TABS = ['overview', 'players', 'alerts', 'diagnostics'];

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
      `script.txt must declare RELEASE_VERSION "${VERSION}"`,
    );
    assert.ok(
      runtime.includes(`const RELEASE_ID = "${RELEASE_ID}"`),
      `script.txt must declare RELEASE_ID "${RELEASE_ID}"`,
    );
    assert.ok(
      runtime.includes(`// @version      ${VERSION}`),
      `script.txt userscript header must carry version ${VERSION}`,
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
        `script.txt must contain the runtime ID "${id}"`,
      );
      assert.ok(
        readme.includes(id),
        `README must document the runtime ID "${id}"`,
      );
    }
    for (const id of ['taa-settings-export', 'taa-settings-import']) {
      assert.ok(
        runtime.includes(`"${id}"`),
        `script.txt must contain the runtime ID "${id}"`,
      );
    }
  });

  it('registers webhook/retry/flush/debug menu labels in runtime', () => {
    for (const label of MENU_LABELS) {
      assert.ok(
        runtime.includes(`GM_registerMenuCommand(\n            "${label}"`) ||
          runtime.includes(`GM_registerMenuCommand("${label}"`) ||
          new RegExp(`GM_registerMenuCommand\\(\\s*"${escapeRegExp(label)}"`).test(runtime),
        `script.txt must register the Tampermonkey menu command "${label}"`,
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
      for (const match of line.matchAll(/\b\d+\.\d+\.\d+\b/g)) {
        if (match[0] === VERSION) continue;
        if (/historical/i.test(line)) continue;
        bad.push(`line ${index + 1}: "${match[0]}" without a historical label`);
      }
      for (const match of line.matchAll(/\btaa-\d+\.\d+\.\d+\b/g)) {
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
