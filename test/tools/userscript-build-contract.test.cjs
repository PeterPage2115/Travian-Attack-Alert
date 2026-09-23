'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILD_FILE = path.join(ROOT, 'tools', 'build.cjs');
const CONFIG_FILE = path.join(ROOT, 'config', 'userscript.json');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_BASENAME = 'travian-attack-alert.user.js';
const DIST_FILE = path.join(DIST_DIR, DIST_BASENAME);
// Desired distribution contract: both metadata URLs must resolve to the
// release branch artifact (the old `main` channel returns HTTP 404).
const RELEASE_URL =
  'https://raw.githubusercontent.com/PeterPage2115/Travian-Attack-Alert/release/public-1.0.0/dist/travian-attack-alert.user.js';

const buildSource = fs.readFileSync(BUILD_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dist = fs.readFileSync(DIST_FILE, 'utf8');
const userscriptConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

function metadataValues(source, directive) {
  const pattern = new RegExp(`^//\\s+@${directive}\\s+(.+)$`, 'gm');
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

describe('generated userscript build contract', () => {
  it('has no root script.txt runtime authority', () => {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'script.txt')),
      false,
      'script.txt must be removed after src becomes the runtime authority',
    );
  });

  it('bundles the sole editable runtime authority from src/userscript-entry.js', () => {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'src', 'userscript-entry.js')),
      true,
      'src/userscript-entry.js must be the explicit browser entry',
    );
    assert.match(
      buildSource,
      /src[^\n]*userscript-entry\.js/,
      'the build must select src/userscript-entry.js as its entry point',
    );
    assert.match(
      buildSource,
      /bundle\s*:\s*true/,
      'the build must bundle src instead of copying a prebuilt runtime',
    );
    assert.doesNotMatch(
      buildSource,
      /(?:ARTIFACT|SOURCE)\s*=.*script\.txt|readFileSync\([^\n]*script\.txt/,
      'the build must not read script.txt as an input artifact',
    );
  });

  it('publishes exactly one installable dist userscript', () => {
    const userscripts = fs
      .readdirSync(DIST_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.user.js'))
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(
      userscripts,
      [DIST_BASENAME],
      `dist must contain only ${DIST_BASENAME} as an installable userscript`,
    );
  });

  it('generates metadata from config/userscript.json and package.json without a version duplicate', () => {
    assert.equal(
      fs.existsSync(CONFIG_FILE),
      true,
      'config/userscript.json must define canonical userscript metadata',
    );

    const userscriptConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    assert.equal(
      Object.hasOwn(userscriptConfig, 'version'),
      false,
      'config/userscript.json must not duplicate package.json version',
    );
    assert.match(
      buildSource,
      /config[^\n]*userscript\.json/,
      'the build must read metadata from config/userscript.json',
    );
    assert.match(buildSource, /package\.json/, 'the build must read the version from package.json');
    assert.deepEqual(
      metadataValues(dist, 'version'),
      [String(pkg.version)],
      'generated @version must equal package.json version exactly once',
    );
  });

  it('contains exactly one complete UserScript metadata block', () => {
    assert.equal(
      (dist.match(/^\/\/ ==UserScript==$/gm) || []).length,
      1,
      'dist must contain one UserScript metadata opening marker',
    );
    assert.equal(
      (dist.match(/^\/\/ ==\/UserScript==$/gm) || []).length,
      1,
      'dist must contain one UserScript metadata closing marker',
    );
  });

  it('contains no unresolved CommonJS require or ESM import syntax', () => {
    assert.doesNotMatch(dist, /\brequire\s*\(/, 'dist must not contain unresolved require(...)');
    assert.doesNotMatch(
      dist,
      /^\s*import(?:\s|\()/m,
      'dist must not contain unresolved static or dynamic import syntax',
    );
  });

  it('propagates the configured updateURL and downloadURL into the generated header', () => {
    assert.deepEqual(
      metadataValues(dist, 'updateURL'),
      [userscriptConfig.updateURL],
      'generated @updateURL must equal config/userscript.json updateURL',
    );
    assert.deepEqual(
      metadataValues(dist, 'downloadURL'),
      [userscriptConfig.downloadURL],
      'generated @downloadURL must equal config/userscript.json downloadURL',
    );
  });

  it('locks updateURL and downloadURL to the release-branch dist URL', () => {
    assert.equal(
      userscriptConfig.updateURL,
      RELEASE_URL,
      'config updateURL must target the release branch, not the old main channel',
    );
    assert.equal(
      userscriptConfig.downloadURL,
      RELEASE_URL,
      'config downloadURL must target the release branch, not the old main channel',
    );
    assert.deepEqual(
      metadataValues(dist, 'updateURL'),
      [RELEASE_URL],
      '@updateURL must point exactly to the generated userscript on the release branch',
    );
    assert.deepEqual(
      metadataValues(dist, 'downloadURL'),
      [RELEASE_URL],
      '@downloadURL must point exactly to the generated userscript on the release branch',
    );
  });
});
