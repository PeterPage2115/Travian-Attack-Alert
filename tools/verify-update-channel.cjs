'use strict';

// Read-only update-channel verifier (Task 13).
//
// Loads config/userscript.json, package.json, dist/<userscript> and its .sha256
// sidecar, then downloads every configured URL and proves the published bytes
// equal the local artifact: HTTP 200, identical SHA-256, identical @version and
// identical @updateURL/@downloadURL directives. stdout is deterministic JSON
// (status, SHA-256, version, directives, verdict) and never contains a response
// body, a response header dump, a query string, or any other remote content.
//
// Opt-in live mode: `node tools/verify-update-channel.cjs` targets the real
// configured URLs and is meant to be run by the owner after the release branch
// is pushed. Automated tests never do that: they inject a loopback origin via
// `--base-url`/TAA_UPDATE_CHANNEL_BASE_URL, which replaces only the
// scheme://host[:port] prefix and keeps the configured path + query.
//
// Exit codes: 0 PASS, 1 verification FAIL, 2 usage/transport/local-read error.
// Flags: --root <dir> --base-url <url> --timeout-ms <n> --max-bytes <n>
// Env:   TAA_ROOT TAA_UPDATE_CHANNEL_BASE_URL TAA_UPDATE_CHANNEL_TIMEOUT_MS
//        TAA_UPDATE_CHANNEL_MAX_BYTES
// Dependencies: node:fs, node:path, node:crypto, node:http, node:https only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const DIST_BASENAME = 'travian-attack-alert.user.js';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const HEADER_OPEN = '// ==UserScript==';
const HEADER_CLOSE = '// ==/UserScript==';
const ROLES = ['updateURL', 'downloadURL'];
const USAGE = [
  'Usage: node tools/verify-update-channel.cjs [options]',
  '  --root <dir>        project root holding config/, package.json, dist/',
  '  --base-url <url>    loopback origin override (tests only; rewrites scheme://host[:port])',
  '  --timeout-ms <n>    per-download timeout in milliseconds (default 15000)',
  '  --max-bytes <n>     maximum accepted response size (default 8388608)',
].join('\n');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseUserscriptHeader(source) {
  const lines = source.split(/\r?\n/);
  const openIndex = lines.indexOf(HEADER_OPEN);
  const closeIndex = lines.indexOf(HEADER_CLOSE);
  if (openIndex === -1 || closeIndex === -1 || closeIndex < openIndex) return { present: false, directives: {} };
  const directives = {};
  const pattern = /^\/\/\s+@([A-Za-z][A-Za-z0-9-]*)\s+(.+?)\s*$/;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const match = pattern.exec(lines[index]);
    if (!match) continue;
    if (!directives[match[1]]) directives[match[1]] = [];
    directives[match[1]].push(match[2]);
  }
  return { present: true, directives };
}

function firstValue(values) {
  return Array.isArray(values) && values.length > 0 ? values[0] : null;
}

function toPositiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`invalid ${label}: ${String(value)}`);
  return number;
}

// Loopback injection: keeps the configured path + query, replaces the origin.
function applyBaseOverride(url, baseUrl) {
  if (!baseUrl) return url;
  const target = new URL(url);
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  return `${base.origin}${prefix}${target.pathname}${target.search}`;
}

// Single bounded GET. Resolves with { status, bytes } or { status, failure }.
// Never rejects: failures are typed strings, so no remote content can leak into
// an exception message. The response body is never read for non-200 statuses,
// and is destroyed mid-stream once maxBytes is exceeded.
function requestOnce(url, options) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let deadline;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch {
      finish({ status: null, failure: 'invalid-url' });
      return;
    }
    const client = target.protocol === 'http:' ? http : target.protocol === 'https:' ? https : null;
    if (!client) {
      finish({ status: null, failure: 'unsupported-protocol' });
      return;
    }
    const req = client.get(target, {
      headers: {
        accept: 'text/plain, */*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': 'taa-verify-update-channel/1.0',
      },
    }, (res) => {
      const status = res.statusCode ?? null;
      if (status !== 200) {
        res.destroy();
        req.destroy();
        finish({ status, failure: `non-200-status:${status}` });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          res.destroy();
          req.destroy();
          finish({ status, failure: 'body-too-large' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ status, bytes: Buffer.concat(chunks) }));
      res.on('error', () => finish({ status, failure: timedOut ? 'timeout' : 'network-error' }));
    });
    req.on('error', () => finish({ status: null, failure: timedOut ? 'timeout' : 'network-error' }));
    deadline = setTimeout(() => {
      timedOut = true;
      req.destroy();
      finish({ status: null, failure: 'timeout' });
    }, options.timeoutMs);
  });
}

function readLocalState(root) {
  const failures = [];
  const configPath = path.join(root, 'config', 'userscript.json');
  const packagePath = path.join(root, 'package.json');
  const distPath = path.join(root, 'dist', DIST_BASENAME);
  const sidecarPath = `${distPath}.sha256`;

  let config = null;
  let pkg = null;
  let distBytes = null;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { failures.push('local-config-unreadable'); }
  try { pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch { failures.push('local-package-unreadable'); }
  try { distBytes = fs.readFileSync(distPath); } catch { failures.push('local-dist-unreadable'); }

  const directives = { updateURL: null, downloadURL: null };
  for (const role of ROLES) {
    const value = config && typeof config[role] === 'string' ? config[role] : null;
    if (!value) {
      failures.push(`local-directive-missing:${role}`);
      continue;
    }
    directives[role] = value;
    let parsed = null;
    try { parsed = new URL(value); } catch { failures.push(`local-directive-invalid:${role}`); continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') failures.push(`local-directive-invalid:${role}`);
  }

  let digest = null;
  let sidecarSha256 = null;
  if (distBytes) {
    digest = sha256(distBytes);
    try {
      const sidecar = fs.readFileSync(sidecarPath, 'utf8');
      const match = /^([0-9a-f]{64}) {2}(.+)\n$/.exec(sidecar);
      if (!match) failures.push('local-sidecar-malformed');
      else {
        sidecarSha256 = match[1];
        if (match[1] !== digest) failures.push('local-sidecar-mismatch');
      }
    } catch {
      failures.push('local-sidecar-unreadable');
    }
  }

  const version = pkg && typeof pkg.version === 'string' ? pkg.version : null;
  if (distBytes) {
    const header = parseUserscriptHeader(distBytes.toString('utf8'));
    if (!header.present) failures.push('local-header-missing');
    else {
      if (!version || firstValue(header.directives.version) !== version) failures.push('local-version-mismatch');
      for (const role of ROLES) {
        if (directives[role] && firstValue(header.directives[role]) !== directives[role]) {
          failures.push(`local-directive-mismatch:${role}`);
        }
      }
    }
  }

  return {
    version,
    releaseId: version ? `taa-${version}` : null,
    sha256: digest,
    sidecarSha256,
    directives,
    failures,
    config,
  };
}

function collectTargets(config) {
  const targets = [];
  const byUrl = new Map();
  for (const role of ROLES) {
    const url = config && typeof config[role] === 'string' ? config[role] : null;
    if (!url) continue;
    if (byUrl.has(url)) {
      byUrl.get(url).roles.push(role);
      continue;
    }
    const target = { url, roles: [role] };
    byUrl.set(url, target);
    targets.push(target);
  }
  return targets;
}

async function evaluateTarget(target, local, options) {
  const response = await requestOnce(applyBaseOverride(target.url, options.baseUrl), options);
  const entry = {
    url: target.url,
    roles: target.roles,
    status: response.status ?? null,
    sha256: null,
    version: null,
    directives: null,
    failures: [],
  };
  if (response.failure) {
    entry.failures.push(response.failure);
    return entry;
  }
  entry.sha256 = sha256(response.bytes);
  const header = parseUserscriptHeader(response.bytes.toString('utf8'));
  if (!header.present) {
    entry.failures.push('header-missing');
    return entry;
  }
  entry.version = firstValue(header.directives.version);
  entry.directives = {
    updateURL: firstValue(header.directives.updateURL),
    downloadURL: firstValue(header.directives.downloadURL),
  };
  if (entry.sha256 !== local.sha256) entry.failures.push('hash-mismatch');
  if (entry.version !== local.version) entry.failures.push('version-mismatch');
  for (const role of ROLES) {
    if (entry.directives[role] !== local.directives[role]) entry.failures.push(`directive-mismatch:${role}`);
  }
  return entry;
}

async function verifyUpdateChannel(options = {}) {
  const root = path.resolve(options.root ?? process.env.TAA_ROOT ?? ROOT);
  const baseUrl = options.baseUrl ?? process.env.TAA_UPDATE_CHANNEL_BASE_URL ?? null;
  const timeoutMs = toPositiveInt(options.timeoutMs ?? process.env.TAA_UPDATE_CHANNEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'timeout-ms');
  const maxBytes = toPositiveInt(options.maxBytes ?? process.env.TAA_UPDATE_CHANNEL_MAX_BYTES, DEFAULT_MAX_BYTES, 'max-bytes');

  const local = readLocalState(root);
  const failures = [...local.failures];
  const targets = [];
  if (local.failures.length === 0) {
    for (const target of collectTargets(local.config)) {
      const entry = await evaluateTarget(target, local, { baseUrl, timeoutMs, maxBytes });
      targets.push(entry);
      for (const failure of entry.failures) failures.push(`${entry.url}: ${failure}`);
    }
  }

  return {
    schemaVersion: 1,
    transport: baseUrl ? 'loopback' : 'live',
    local: {
      version: local.version,
      releaseId: local.releaseId,
      sha256: local.sha256,
      sidecarSha256: local.sidecarSha256,
      directives: local.directives,
    },
    targets,
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unsupported argument: ${arg}`);
    const key = arg.slice(2);
    if (!['root', 'base-url', 'timeout-ms', 'max-bytes'].includes(key)) throw new Error(`unsupported argument: ${arg}`);
    if (index + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
    parsed[key] = argv[++index];
  }
  return parsed;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await verifyUpdateChannel({
    root: args.root,
    baseUrl: args['base-url'],
    timeoutMs: args['timeout-ms'],
    maxBytes: args['max-bytes'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.verdict !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`verify-update-channel: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { verifyUpdateChannel, parseUserscriptHeader, applyBaseOverride };
