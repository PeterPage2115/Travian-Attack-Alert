#!/usr/bin/env node
'use strict';

// Release readiness verifier — Task 28 foundation (extended by Task 30).
//
// This module owns the release-asset CONTRACT and its fail-closed directory
// verifier. The contract is deliberately exhaustive: a prepared release
// directory is valid only when it contains EXACTLY the seven declared assets
// and every byte re-hashes to the digests recorded in `release-manifest.json`
// and `SHA256SUMS`.
//
// The seven assets (flat, basename-only):
//   1. travian-attack-alert.user.js          generated userscript
//   2. travian-attack-alert.user.js.sha256   existing userscript sidecar
//   3. metadata.json                         generated build metadata
//   4. module-manifest.json                  generated module manifest
//   5. sbom.spdx.json                        SPDX-2.3 BUILD-dependency SBOM
//   6. release-manifest.json                 release descriptor
//   7. SHA256SUMS                            checksums of 1-5 + 6
//
// The release manifest intentionally does NOT digest SHA256SUMS (or itself),
// so there is no circular hash. SHA256SUMS covers the five primary assets plus
// release-manifest.json, never itself.
//
// Verification rejects, with a typed `code`:
//   malformed-release-manifest, malformed-sbom, malformed-sha256sums,
//   unsupported-schema, path-traversal, duplicate-asset, missing-asset,
//   unexpected-asset, non-regular-asset, digest-mismatch, checksum-mismatch,
//   sidecar-mismatch, self-referential-asset, sbom-classification-mismatch,
//   sbom-runtime-dependency-misstatement, sbom-timestamp-mismatch.
//
// Exit codes: 0 PASS, 1 verification FAIL, 2 usage/read error.
// Flags: --root <dir> --dir <releaseDir> --json
// Env:   TAA_ROOT
// Dependencies: node:fs, node:path, node:crypto only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TAA_ROOT ? path.resolve(process.env.TAA_ROOT) : path.resolve(__dirname, '..');

const USERSCRIPT = 'travian-attack-alert.user.js';
const SIDECAR = `${USERSCRIPT}.sha256`;
const METADATA = 'metadata.json';
const MODULE_MANIFEST = 'module-manifest.json';
const SBOM = 'sbom.spdx.json';
const RELEASE_MANIFEST = 'release-manifest.json';
const SHA256SUMS = 'SHA256SUMS';
const PRIMARY_ASSETS = [USERSCRIPT, SIDECAR, METADATA, MODULE_MANIFEST, SBOM];
const SHA256SUMS_ASSETS = [...PRIMARY_ASSETS, RELEASE_MANIFEST];
const ALL_ASSETS = [...PRIMARY_ASSETS, RELEASE_MANIFEST, SHA256SUMS];
const SPDX_VERSION = 'SPDX-2.3';
const SBOM_CLASSIFICATION = 'build-dependency';
const ZERO_RUNTIME_DEPENDENCIES_STATEMENT = 'The browser userscript has zero runtime package dependencies.';

const USAGE = [
  'Usage: node tools/check-release-readiness.cjs [options]',
  '  --root <dir>   project root (defaults to TAA_ROOT or the repository root)',
  '  --dir <dir>    prepared release directory (defaults to <root>/release)',
  '  --json         emit machine-readable JSON',
].join('\n');

class ReleaseError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function isPlainName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name === path.basename(name)
    && !name.includes('/')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..'
    && !path.isAbsolute(name);
}

function requirePlainName(name, code, label) {
  if (!isPlainName(name)) throw new ReleaseError(code, `${label} is not a plain basename: ${String(name)}`);
}

function readRegularFile(dir, name) {
  const file = path.join(dir, name);
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch {
    throw new ReleaseError('missing-asset', `release asset is missing: ${name}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ReleaseError('non-regular-asset', `release asset is not a regular file: ${name}`);
  }
  return fs.readFileSync(file);
}

function readJsonAsset(dir, name) {
  const bytes = readRegularFile(dir, name);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const code = name === SBOM ? 'malformed-sbom' : 'malformed-release-manifest';
    throw new ReleaseError(code, `${name} is not valid JSON: ${error.message}`);
  }
}

function parseSha256Sums(text) {
  const entries = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new ReleaseError('malformed-sha256sums', `SHA256SUMS line is malformed: ${line}`);
    const name = match[2];
    requirePlainName(name, 'path-traversal', 'SHA256SUMS entry');
    if (seen.has(name)) throw new ReleaseError('duplicate-asset', `SHA256SUMS lists a duplicate name: ${name}`);
    seen.add(name);
    entries.push({ sha256: match[1], name });
  }
  return entries;
}

function epochToSpdx(epoch) {
  return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ReleaseError('malformed-release-manifest', 'release-manifest.json must be a JSON object');
  }
  if (manifest.schemaVersion !== 1) throw new ReleaseError('unsupported-schema', `unsupported release-manifest schemaVersion: ${String(manifest.schemaVersion)}`);
  if (typeof manifest.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new ReleaseError('malformed-release-manifest', `release version is invalid: ${String(manifest.version)}`);
  }
  if (manifest.releaseId !== `taa-${manifest.version}`) throw new ReleaseError('malformed-release-manifest', `releaseId must be taa-${manifest.version}`);
  if (manifest.tag !== `v${manifest.version}`) throw new ReleaseError('malformed-release-manifest', `tag must be v${manifest.version}`);
  const source = manifest.source;
  if (!source || !/^[0-9a-f]{40}$/.test(source.commit || '') || !/^[0-9a-f]{40}$/.test(source.tree || '')) {
    throw new ReleaseError('malformed-release-manifest', 'source.commit and source.tree must be 40-hex git object ids');
  }
  if (typeof source.branch !== 'string' || source.branch.length === 0) throw new ReleaseError('malformed-release-manifest', 'source.branch is missing');
  if (!Number.isInteger(source.sourceDateEpoch) || source.sourceDateEpoch < 0) throw new ReleaseError('malformed-release-manifest', 'source.sourceDateEpoch must be a non-negative integer');
  const toolchain = manifest.toolchain;
  if (!toolchain || typeof toolchain.esbuild !== 'string' || typeof toolchain.typescript !== 'string' || !Number.isInteger(toolchain.nodeMajor)) {
    throw new ReleaseError('malformed-release-manifest', 'toolchain must pin esbuild, typescript and nodeMajor');
  }
  const sbom = manifest.sbom;
  if (!sbom || sbom.file !== SBOM || sbom.format !== SPDX_VERSION || sbom.classification !== SBOM_CLASSIFICATION) {
    throw new ReleaseError('sbom-classification-mismatch', `release-manifest sbom must declare ${SBOM} as an ${SBOM_CLASSIFICATION} ${SPDX_VERSION} document`);
  }
  if (sbom.runtimeDependencies !== 0 || sbom.statement !== ZERO_RUNTIME_DEPENDENCIES_STATEMENT) {
    throw new ReleaseError('sbom-runtime-dependency-misstatement', 'release-manifest must state the userscript has zero runtime package dependencies');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== PRIMARY_ASSETS.length) {
    throw new ReleaseError('malformed-release-manifest', `release-manifest must declare exactly ${PRIMARY_ASSETS.length} primary assets`);
  }
  const names = manifest.assets.map((asset) => asset && asset.name);
  for (const name of names) requirePlainName(name, 'path-traversal', 'release-manifest asset name');
  for (const forbidden of [SHA256SUMS, RELEASE_MANIFEST]) {
    if (names.includes(forbidden)) throw new ReleaseError('self-referential-asset', `release-manifest must not digest ${forbidden}`);
  }
  if (new Set(names).size !== names.length) throw new ReleaseError('duplicate-asset', 'release-manifest declares duplicate asset names');
  for (let index = 0; index < PRIMARY_ASSETS.length; index += 1) {
    if (names[index] !== PRIMARY_ASSETS[index]) {
      throw new ReleaseError('malformed-release-manifest', `release-manifest assets must be ordered ${PRIMARY_ASSETS.join(', ')}`);
    }
    const asset = manifest.assets[index];
    if (!Number.isInteger(asset.bytes) || asset.bytes < 0 || !/^[0-9a-f]{64}$/.test(asset.sha256 || '')) {
      throw new ReleaseError('malformed-release-manifest', `release-manifest asset ${asset.name} needs integer bytes and a sha256 digest`);
    }
  }
}

function verifySbom(sbom, manifest) {
  if (!sbom || typeof sbom !== 'object' || Array.isArray(sbom)) throw new ReleaseError('malformed-sbom', 'sbom.spdx.json must be a JSON object');
  if (sbom.spdxVersion !== SPDX_VERSION) throw new ReleaseError('malformed-sbom', `sbom spdxVersion must be ${SPDX_VERSION}`);
  if (sbom.dataLicense !== 'CC0-1.0') throw new ReleaseError('malformed-sbom', 'sbom dataLicense must be CC0-1.0');
  if (sbom.SPDXID !== 'SPDXRef-DOCUMENT') throw new ReleaseError('malformed-sbom', 'sbom SPDXID must be SPDXRef-DOCUMENT');
  const info = sbom.creationInfo;
  const expectedCreated = epochToSpdx(manifest.source.sourceDateEpoch);
  if (!info || info.created !== expectedCreated) {
    throw new ReleaseError('sbom-timestamp-mismatch', `sbom creation timestamp must derive from SOURCE_DATE_EPOCH (${expectedCreated})`);
  }
  const packages = Array.isArray(sbom.packages) ? sbom.packages : null;
  if (!packages || packages.length === 0) throw new ReleaseError('malformed-sbom', 'sbom must declare packages');
  const ids = new Set();
  for (const pkg of packages) {
    if (!pkg || typeof pkg.SPDXID !== 'string' || typeof pkg.name !== 'string') throw new ReleaseError('malformed-sbom', 'each sbom package needs SPDXID and name');
    if (ids.has(pkg.SPDXID)) throw new ReleaseError('duplicate-asset', `sbom declares duplicate SPDXID ${pkg.SPDXID}`);
    ids.add(pkg.SPDXID);
  }
  const root = packages.find((pkg) => pkg.primaryPackagePurpose === 'APPLICATION');
  if (!root) throw new ReleaseError('malformed-sbom', 'sbom must declare the userscript APPLICATION package');
  if (typeof root.comment !== 'string' || !root.comment.includes(ZERO_RUNTIME_DEPENDENCIES_STATEMENT)) {
    throw new ReleaseError('sbom-runtime-dependency-misstatement', 'sbom root package must state zero runtime package dependencies');
  }
  const relationships = Array.isArray(sbom.relationships) ? sbom.relationships : [];
  for (const relationship of relationships) {
    if (!relationship || typeof relationship.spdxElementId !== 'string' || typeof relationship.relationshipType !== 'string') {
      throw new ReleaseError('malformed-sbom', 'each sbom relationship needs spdxElementId and relationshipType');
    }
    if (relationship.relationshipType === 'RUNTIME_DEPENDENCY_OF' || relationship.relationshipType === 'DEPENDENCY_OF') {
      throw new ReleaseError('sbom-runtime-dependency-misstatement', `sbom must not declare runtime dependencies (${relationship.spdxElementId} ${relationship.relationshipType})`);
    }
  }
  const describes = Array.isArray(sbom.documentDescribes) ? sbom.documentDescribes : [];
  if (!describes.includes(root.SPDXID)) throw new ReleaseError('malformed-sbom', 'sbom documentDescribes must name the userscript package');
}

function verifyReleaseDirectory(dir) {
  let dirStats;
  try {
    dirStats = fs.lstatSync(dir);
  } catch {
    throw new ReleaseError('missing-asset', `release directory is missing: ${dir}`);
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) throw new ReleaseError('non-regular-asset', `release path is not a directory: ${dir}`);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const present = new Set();
  for (const entry of entries) {
    requirePlainName(entry.name, 'path-traversal', 'release directory entry');
    if (!entry.isFile()) throw new ReleaseError('non-regular-asset', `release entry is not a regular file: ${entry.name}`);
    if (present.has(entry.name)) throw new ReleaseError('duplicate-asset', `release directory lists a duplicate name: ${entry.name}`);
    present.add(entry.name);
  }
  for (const name of ALL_ASSETS) {
    if (!present.has(name)) throw new ReleaseError('missing-asset', `release asset is missing: ${name}`);
  }
  for (const name of present) {
    if (!ALL_ASSETS.includes(name)) throw new ReleaseError('unexpected-asset', `release directory contains an undeclared asset: ${name}`);
  }

  const manifest = readJsonAsset(dir, RELEASE_MANIFEST);
  verifyManifest(manifest);

  const actualDigests = new Map();
  for (const asset of manifest.assets) {
    const bytes = readRegularFile(dir, asset.name);
    const digest = sha256(bytes);
    if (bytes.length !== asset.bytes || digest !== asset.sha256) {
      throw new ReleaseError('digest-mismatch', `release-manifest digest mismatch for ${asset.name}`);
    }
    actualDigests.set(asset.name, { bytes: bytes.length, sha256: digest });
  }

  const sumsText = readRegularFile(dir, SHA256SUMS).toString('utf8');
  const sums = parseSha256Sums(sumsText);
  const sumNames = sums.map((entry) => entry.name);
  if (sumNames.length !== SHA256SUMS_ASSETS.length || SHA256SUMS_ASSETS.some((name, index) => sumNames[index] !== name)) {
    throw new ReleaseError('malformed-sha256sums', `SHA256SUMS must list exactly ${SHA256SUMS_ASSETS.join(', ')} in order`);
  }
  for (const entry of sums) {
    const bytes = readRegularFile(dir, entry.name);
    if (sha256(bytes) !== entry.sha256) throw new ReleaseError('checksum-mismatch', `SHA256SUMS digest mismatch for ${entry.name}`);
  }

  // Sidecar consistency: the existing sidecar records the userscript digest.
  const sidecarText = readRegularFile(dir, SIDECAR).toString('utf8');
  const sidecarMatch = /^([0-9a-f]{64}) {2}/.exec(sidecarText);
  if (!sidecarMatch) throw new ReleaseError('malformed-sha256sums', 'userscript sidecar does not start with a sha256 digest');
  if (sidecarMatch[1] !== actualDigests.get(USERSCRIPT).sha256) {
    throw new ReleaseError('sidecar-mismatch', 'userscript sidecar digest does not match the userscript asset');
  }

  verifySbom(readJsonAsset(dir, SBOM), manifest);

  return {
    verdict: 'PASS',
    directory: dir,
    version: manifest.version,
    releaseId: manifest.releaseId,
    tag: manifest.tag,
    commit: manifest.source.commit,
    tree: manifest.source.tree,
    assetCount: ALL_ASSETS.length,
    primaryAssetCount: manifest.assets.length,
    assets: manifest.assets.map((asset) => ({ name: asset.name, bytes: asset.bytes, sha256: asset.sha256 })),
  };
}

function parseArgs(argv) {
  const options = { root: ROOT, dir: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') { options.root = path.resolve(argv[++index] || ''); }
    else if (arg === '--dir') { options.dir = path.resolve(argv[++index] || ''); }
    else if (arg === '--json') { options.json = true; }
    else throw new ReleaseError('usage', `unknown argument: ${arg}\n${USAGE}`, 2);
  }
  if (!options.dir) options.dir = path.join(options.root, 'release');
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || 2;
    return;
  }
  try {
    const result = verifyReleaseDirectory(options.dir);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`RELEASE CHECK PASS: ${result.releaseId} ${result.tag} ${result.assetCount} assets at ${result.directory}\n`);
    process.exitCode = 0;
  } catch (error) {
    const code = error instanceof ReleaseError ? error.code : 'internal-error';
    if (options.json) process.stdout.write(`${JSON.stringify({ verdict: 'FAIL', code, message: error.message }, null, 2)}\n`);
    else process.stderr.write(`RELEASE CHECK FAIL: ${code}: ${error.message}\n`);
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 2;
  }
}

if (require.main === module) main();

module.exports = {
  ReleaseError,
  verifyReleaseDirectory,
  verifyManifest,
  verifySbom,
  parseSha256Sums,
  sha256,
  sha256File,
  epochToSpdx,
  isPlainName,
  constants: {
    ROOT,
    USERSCRIPT,
    SIDECAR,
    METADATA,
    MODULE_MANIFEST,
    SBOM,
    RELEASE_MANIFEST,
    SHA256SUMS,
    PRIMARY_ASSETS,
    SHA256SUMS_ASSETS,
    ALL_ASSETS,
    SPDX_VERSION,
    SBOM_CLASSIFICATION,
    ZERO_RUNTIME_DEPENDENCIES_STATEMENT,
  },
};
