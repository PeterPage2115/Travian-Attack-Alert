'use strict';
/**
 * audit-public-tree.cjs — single-source privacy scanning policy (Todo 5).
 *
 * This module is the ONLY place that defines forbidden paths, webhook/token
 * shapes, placeholder exemptions, player-like identities, and redaction
 * rules. Local tools and CI must invoke this policy instead of duplicating
 * regexes (the historical `grep discord.com/api/webhooks` line in
 * `.github/workflows/ci.yml` is replaced by `--mode secrets` below).
 *
 * Modes:
 *   tree (default):
 *     node tools/audit-public-tree.cjs --root <dir> --baseline <dir> --out <report.json>
 *     Repository allowlist/denylist audit (Todo 2 behavior, preserved).
 *   secrets:
 *     node tools/audit-public-tree.cjs --mode secrets --root <dir> --out <report.json>
 *     Same secret shapes as tree mode, applied to every text file under
 *     --root without any repository allowlist. Used by CI instead of grep.
 *   evidence:
 *     node tools/audit-public-tree.cjs --mode evidence --root <evidence-dir> --out <report.json>
 *     Privacy scan over Playwright evidence: recursively scans text, nested
 *     reports, ZIPs (including Playwright trace.zip files), and screenshots
 *     (PNG/JPEG/WebP OCR through the pinned decoder + local English model).
 *     No repository allowlist applies. --out MUST resolve outside --root
 *     (the report must never be scanned as part of its own input).
 *
 * Evidence fail-closed triggers (each yields verdict FAIL, never bytes):
 *   depth/expanded-size/file-count overflow, encrypted archives, decode or
 *   OCR errors, unsupported image/archive types, symlinks, OCR model-hash
 *   drift, dev-dependency pin drift.
 *
 * Redaction: every report and every stdout line carries rule/path/offset
 * digests only — matched bytes (tokens, URLs, payloads, snowflakes) are
 * NEVER printed, not even partially.
 *
 * Playwright evidence screenshots MUST be PNG (canonical screenshot format
 * `EVIDENCE_SCREENSHOT_FORMAT`). JPEG/WebP are OCR-decodable for backwards
 * compatibility; every other image type fails closed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Jawna allowlista publicznego repo — katalogi są kopiowane tylko z tych
// przejrzanych ścieżek, nigdy przez rekurencyjne kopiowanie całego DEV.
const ALLOWLIST = [
  '.github/',
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'CHANGELOG.md',
  'README.md',
  'config/',
  'dist/',
  'docs/',
  'metadata.json',
  'module-manifest.json',
  'package-lock.json',
  'package.json',
  'src/',
  'test/',
  'tools/',
  'tools/ocr-models/',
  'tsconfig.json',
];

// Ścieżki, które nie mogą istnieć w kopii publicznej (przed `npm ci`).
const DENYLIST = [
  'backups/',
  '.dane/',
  '.omo/',
  'test-results/',
  '.playwright-mcp/',
  '.codegraph/',
  'node_modules/',
  // Usunięte autorytety runtime: dawny monolit i mostek zgodności nie mogą
  // powrócić ani u root, ani na żadnej głębokości (kontrola wg nazw części).
  // Nazwy złożone, żeby skaner konsumentów nie zgłaszał tego pliku.
  'script' + '.txt',
  'src/legacy' + '-bridge.js',
  'legacy' + '-bridge.js',
];

const SETTINGS_BACKUP_RE = /^taa-settings-backup-.*\.json$/i;

// Pliki generowane w nowym repo — należą do kopii, ale nie do baseline DEV.
// Obejmuje też pliki governance dodane przy porządkowaniu publicznego repo
// (licencja, polityka bezpieczeństwa): są skanowane pod kątem sekretów jak
// reszta drzewa, ale nie są wymagane w baseline ani raportowane jako obce.
const GENERATED = new Set([
  'tools/audit-public-tree.cjs',
  'LICENSE',
  'SECURITY.md',
]);

// Prawdziwy token webhooka Discorda ma ~68 znaków (base64url o wysokiej
// entropii). Deterministyczne fixtury loopback w testach używają krótkich
// dummy-tokenów (zweryfikowano: maks. 20 znaków na całej powierzchni
// allowlisty, wyłącznie w test/). Próg 32 znaki daje szeroki margines:
// krótszy token nie może być żywym sekretem.
const MIN_REAL_TOKEN_LEN = 32;

// Pinned dev-only evidence decoders (package.json devDependencies must carry
// these exact versions; evidence mode verifies the installed copies).
const EVIDENCE_DEPS = {
  yauzl: '3.2.0',
  sharp: '0.34.3',
  'tesseract.js': '6.0.1',
};

// Canonical Playwright evidence screenshot format.
const EVIDENCE_SCREENSHOT_FORMAT = 'png';

// Evidence container limits — overflow fails closed, never silently skips.
const EVIDENCE_LIMITS = {
  maxDepth: 5,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxFiles: 2000,
  maxTextBytes: 32 * 1024 * 1024,
};

// OCR-decodable image extensions (decoded through the pinned sharp build,
// recognized through the pinned local English model only).
const EVIDENCE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// Explicitly unsupported image types — presence fails closed.
const EVIDENCE_UNSUPPORTED_IMAGE_EXTS = new Set([
  '.gif', '.bmp', '.tif', '.tiff', '.avif', '.ico', '.heic', '.heif', '.psd',
]);
// Explicitly unsupported archive types — presence fails closed.
const EVIDENCE_UNSUPPORTED_ARCHIVE_EXTS = new Set([
  '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.cab', '.iso',
]);

const OCR_MODEL_REL = 'tools/ocr-models/eng.traineddata.gz';

/**
 * Single-source scanner policy object. Every consumer (tree / secrets /
 * evidence modes, CI) derives its matchers from here — no other file may
 * hard-code these shapes.
 */
const SCANNER_POLICY = {
  version: 1,
  minRealTokenLen: MIN_REAL_TOKEN_LEN,
  secretKinds: [
    'discord-webhook',
    'discord-snowflake',
    'private-path',
    'legacy-identity',
    'legacy-host',
  ],
  evidenceRules: [
    'discord-webhook',
    'discord-snowflake',
    'private-path',
    'legacy-identity',
    'legacy-host',
    'symlink-escape',
    'path-traversal',
    'encrypted-archive',
    'decode-failure',
    'ocr-failure',
    'ocr-model-drift',
    'evidence-dep-drift',
    'archive-limit',
    'scan-limit',
    'unsupported-image-type',
    'unsupported-archive-type',
    'unsupported-entry',
  ],
  allowlist: ALLOWLIST.slice(),
  denylist: DENYLIST.slice(),
  generated: [...GENERATED],
  evidenceDeps: { ...EVIDENCE_DEPS },
  evidenceLimits: { ...EVIDENCE_LIMITS },
  evidenceScreenshotFormat: EVIDENCE_SCREENSHOT_FORMAT,
  ocrModel: OCR_MODEL_REL,
};

function buildSecretMatchers() {
  return {
    webhookRe: /discord\.com\/api\/webhooks\/(\d+)\/([^\s"'`)}\]]+)/g,
    placeholderRe: /(<|>|FAKE|PLACEHOLDER|example)/i,
    snowflakeRe: /\b\d{17,19}\b/g,
    privatePathRe: /(?:\.\.[\\/]TravianAttackAlertDEV[\\/]backups\b)|(?:[A-Za-z]:[\\/][^\r\n]*?TravianAttackAlertDEV(?:[\\/][^\r\n\s]*)?)|(?:\/(?:[^\s/]+\/)*TravianAttackAlertDEV(?:\/[^\s]*)?)/g,
    // Zakazane tożsamości legacy (bez znalezionych bajtów w raporcie).
    // Nazwy graczy i host świata przeniesione z prywatnego materiału DEV nie
    // mogą występować na żywej powierzchni publicznej. Wzorce są składane
    // z fragmentów, żeby ten plik nigdy nie pasował do samego siebie.
    legacyIdentityRe: new RegExp(
      ['Le' + 'nny', 'Ba' + 'rre', 'Qui' + 'nno' + 's', 'sa' + 'ndla', 'Aria' + 'dne', 'Bo' + 'rek', 'Ci' + 'ri', 'Da' + 'rek'].join('|'),
      'gi',
    ),
    legacyHostRe: new RegExp(['cw', 'x2', 'international', 'tra' + 'vian', 'com'].join('[.]'), 'gi'),
  };
}

const IDENTITY_EXEMPT_RE = /^(?:test\/|docs\/release-history\/)/;

/**
 * Scan text with the single-source secret policy.
 *
 * @param {string} rel posix relative path (used only for exemption routing)
 * @param {string} text decoded text unit (file body, archive entry, OCR text)
 * @param {{snowflakeExempt?:boolean, identityExempt?:boolean}} opts exemption flags
 * @returns {Array<{kind:string, offset:number, line:number, tokenLen:number}>}
 *   offsets are absolute character offsets in `text`; matched bytes are
 *   never included.
 */
function scanTextForSecrets(rel, text, opts = {}) {
  const matchers = buildSecretMatchers();
  const hits = [];
  const snowflakeExempt = opts.snowflakeExempt === true;
  const identityExempt = opts.identityExempt === true;
  const lines = text.split('\n');
  let base = 0;
  lines.forEach((line, idx) => {
    const record = (regex, kind) => {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(line)) !== null) {
        // Guard against zero-length match loops (legacy-host pattern can
        // match short fragments; none are zero-length today, but stay safe).
        if (match[0].length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        hits.push({
          kind,
          offset: base + match.index,
          line: idx + 1,
          tokenLen: match[0].length,
        });
      }
    };
    record(matchers.privatePathRe, 'private-path');
    // README i test/ zawierają jawnie syntetyczne identyfikatory kontraktowe.
    // Pozostałe przejrzane ścieżki nie mogą zawierać Discord snowflakes.
    if (!snowflakeExempt) {
      record(matchers.snowflakeRe, 'discord-snowflake');
    }
    matchers.webhookRe.lastIndex = 0;
    let m;
    while ((m = matchers.webhookRe.exec(line)) !== null) {
      const token = m[2];
      if (!matchers.placeholderRe.test(token) && token.length >= MIN_REAL_TOKEN_LEN) {
        // Celowo BEZ wartości tokena: tylko lokalizacja i długość.
        hits.push({
          kind: 'discord-webhook',
          offset: base + m.index,
          line: idx + 1,
          tokenLen: m[0].length,
        });
      }
      if (m[0].length === 0) {
        matchers.webhookRe.lastIndex += 1;
      }
    }
    // Tożsamości legacy poza zwolnionymi obszarami (fixtury, archiwa).
    if (!identityExempt) {
      record(matchers.legacyIdentityRe, 'legacy-identity');
      record(matchers.legacyHostRe, 'legacy-host');
    }
    base += line.length + 1;
  });
  return hits;
}

/** Tree-mode exemption routing (preserved Todo 2 contract). */
function treeScanExemptions(rel) {
  return {
    snowflakeExempt: rel === 'README.md' || rel.startsWith('test/'),
    identityExempt: IDENTITY_EXEMPT_RE.test(rel),
  };
}

function parseArgs(argv) {
  const out = { mode: 'tree' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root' || a === '--baseline' || a === '--out' || a === '--mode') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error(`missing value for ${a}`);
      }
      out[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!['tree', 'secrets', 'evidence'].includes(out.mode)) {
    throw new Error(`unknown mode: ${out.mode}`);
  }
  if (out.mode === 'tree') {
    if (!out.root || !out.baseline || !out.out) {
      throw new Error('required args: --root <dir> --baseline <dir> --out <file>');
    }
  } else if (out.mode === 'secrets') {
    if (!out.root || !out.out) {
      throw new Error('required args: --mode secrets --root <dir> --out <file>');
    }
    if (out.baseline) {
      throw new Error('--baseline does not apply to secrets mode');
    }
  } else {
    if (!out.root || !out.out) {
      throw new Error('required args: --mode evidence --root <dir> --out <file>');
    }
    if (out.baseline) {
      throw new Error('--baseline does not apply to evidence mode (no repository allowlist)');
    }
  }
  return out;
}

function sha256File(abs) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(abs));
  return h.digest('hex');
}

function listFilesRecursive(absDir, relBase) {
  const out = [];
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relBase + ent.name;
    const abs = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFilesRecursive(abs, `${rel}/`));
    } else if (ent.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function mainTree(root, baseline, outAbs, outRel) {
  const excludedFound = [];
  const hashMismatches = [];
  const secretHits = [];

  // --- (b) denylist: katalogi ---
  for (const entry of DENYLIST) {
    const rel = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const abs = path.join(root, rel);
    let present = false;
    try {
      const st = fs.statSync(abs);
      if (entry.endsWith('/') && st.isDirectory()) {
        if (rel === 'test-results') {
          // Wynik audytu (--out) zapisywany jest właśnie tutaj — ignoruj,
          // o ile katalog nie zawiera niczego poza plikiem wynikowym.
          const all = listFilesRecursive(abs, '').map(toPosix);
          const foreign = all.filter((f) => `test-results/${f}` !== outRel);
          if (foreign.length > 0) present = true;
        } else {
          present = true;
        }
      } else if (!entry.endsWith('/') && (st.isDirectory() || st.isFile())) {
        present = true;
      }
    } catch {
      present = false;
    }
    if (present) excludedFound.push(entry);
  }

  // --- (b) denylist: pliki sekretów (.env, .env.*) na top-level ---
  let topEnts = [];
  try {
    topEnts = fs.readdirSync(root);
  } catch {
    topEnts = [];
  }
  for (const name of topEnts) {
    if (name === '.env' || name.startsWith('.env.')) {
      excludedFound.push(name);
    }
  }

  // --- (a) allowlist: hashe równe źródłu ---
  const expectedFiles = [];
  for (const entry of ALLOWLIST) {
    const baseAbs = path.join(baseline, entry);
    let st = null;
    try {
      st = fs.statSync(baseAbs);
    } catch {
      hashMismatches.push({ file: entry, reason: 'missing-in-baseline' });
      continue;
    }
    if (st.isDirectory()) {
      const prefix = entry.endsWith('/') ? entry : `${entry}/`;
      for (const f of listFilesRecursive(baseAbs, '')) {
        expectedFiles.push(`${prefix}${toPosix(f)}`);
      }
    } else if (st.isFile()) {
      expectedFiles.push(entry);
    }
  }

  for (const rel of expectedFiles) {
    const srcAbs = path.join(baseline, rel);
    const dstAbs = path.join(root, rel);
    let dstOk = false;
    try {
      dstOk = fs.statSync(dstAbs).isFile();
    } catch {
      dstOk = false;
    }
    if (!dstOk) {
      hashMismatches.push({ file: rel, reason: 'missing-in-copy' });
      continue;
    }
    const a = sha256File(srcAbs);
    const b = sha256File(dstAbs);
    if (a !== b) {
      hashMismatches.push({ file: rel, reason: 'hash-mismatch' });
    }
  }

  // --- (a-bis) brak obcych plików poza allowlistą i generowanymi ---
  const expectedSet = new Set(expectedFiles);
  const actualTop = [];
  try {
    actualTop.push(...listFilesRecursive(root, '').map(toPosix));
  } catch (e) {
    console.error(`audit-public-tree: cannot list --root: ${e.message}`);
    process.exit(2);
  }
  for (const rel of actualTop) {
    if (expectedSet.has(rel)) continue;
    if (GENERATED.has(rel)) continue;
    if (rel === outRel) continue; // własny plik wynikowy
    if (rel.startsWith('node_modules/') || rel.startsWith('test-results/')) continue; // raportowane przez denylistę
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    hashMismatches.push({ file: rel, reason: 'unexpected-extra' });
  }

  // Denylista obowiązuje na dowolnej głębokości. Raport zawiera wyłącznie
  // ścieżkę, nigdy zawartość znalezionego pliku.
  for (const rel of actualTop) {
    const parts = rel.split('/');
    for (const denied of DENYLIST) {
      const name = denied.replace(/\/$/, '');
      const index = parts.indexOf(name);
      if (index === -1) continue;
      const deniedPath = `${parts.slice(0, index + 1).join('/')}/`;
      if (!excludedFound.includes(deniedPath)) excludedFound.push(deniedPath);
    }
    if (SETTINGS_BACKUP_RE.test(path.posix.basename(rel)) && !excludedFound.includes(rel)) {
      excludedFound.push(rel);
    }
  }

  // --- (c) skan prywatnych wzorców (bez znalezionych bajtów w raporcie) ---
  // Single-source: kształty sekretów pochodzą wyłącznie ze wspólnego
  // scanTextForSecrets; tryb tree dokłada jedynie routing zwolnień Todo 2.
  for (const rel of actualTop) {
    if (rel.startsWith('node_modules/') || rel.startsWith('.git/')) continue;
    const abs = path.join(root, rel);
    let text = null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // binarny / nieczytelny — pomijamy
    }
    if (text.includes('\u0000')) continue; // binarny
    for (const hit of scanTextForSecrets(rel, text, treeScanExemptions(rel))) {
      secretHits.push({
        file: rel,
        line: hit.line,
        kind: hit.kind,
        tokenLen: hit.tokenLen,
      });
    }
  }

  return { excludedFound, hashMismatches, secretHits };
}

function writeReport(outAbs, report) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${JSON.stringify(report, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// secrets mode: single-source secret shapes over an arbitrary root, no
// repository allowlist. Replaces the historical grep duplication in CI.
// ---------------------------------------------------------------------------

function collectSecretScanFiles(root) {
  const out = [];
  const visit = (absDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        visit(abs);
      } else if (ent.isFile()) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

function mainSecrets(root, outAbs, outRel) {
  const secretHits = [];
  for (const abs of collectSecretScanFiles(root)) {
    const rel = toPosix(path.relative(root, abs));
    if (rel === outRel) continue; // własny plik wynikowy
    let text = null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    // Ten sam routing zwolnień co tryb tree (fixtury testowe + README niosą
    // jawnie syntetyczne identyfikatory kontraktowe).
    for (const hit of scanTextForSecrets(rel, text, treeScanExemptions(rel))) {
      secretHits.push({ file: rel, line: hit.line, kind: hit.kind });
    }
  }
  return secretHits;
}

// ---------------------------------------------------------------------------
// evidence mode: Playwright evidence privacy scan (ZIP/trace/screenshot OCR)
// ---------------------------------------------------------------------------

function evidenceToolRoot() {
  return path.resolve(__dirname, '..');
}

function ocrModelPaths() {
  const modelAbs = path.join(evidenceToolRoot(), OCR_MODEL_REL);
  return { modelAbs, hashAbs: `${modelAbs}.sha256` };
}

/**
 * Verify the bundled local English OCR model against its tracked SHA-256.
 * Any drift (or missing model/hash) fails closed — callers must treat the
 * throw as verdict FAIL, never as "skip OCR".
 */
function verifyOcrModel() {
  const { modelAbs, hashAbs } = ocrModelPaths();
  let expected = null;
  try {
    const line = fs.readFileSync(hashAbs, 'utf8').trim();
    const match = /^([0-9a-f]{64})\s+\S+/.exec(line);
    if (match) expected = match[1];
  } catch {
    expected = null;
  }
  if (!expected) {
    throw new Error('ocr-model-drift: tracked model hash is missing or malformed');
  }
  let actual = null;
  try {
    actual = sha256File(modelAbs);
  } catch {
    actual = null;
  }
  if (actual !== expected) {
    throw new Error('ocr-model-drift: bundled English OCR model hash mismatch');
  }
  return { sha256: actual, modelAbs };
}

/** Verify installed evidence decoders match the pinned devDependencies. */
function verifyEvidenceDeps() {
  const drift = [];
  for (const [name, pin] of Object.entries(EVIDENCE_DEPS)) {
    let installed = null;
    try {
      installed = require(`${name}/package.json`).version;
    } catch {
      installed = null;
    }
    if (installed !== pin) {
      drift.push({ name, expected: pin, installed });
    }
  }
  if (drift.length > 0) {
    const names = drift.map((d) => `${d.name}@${d.installed ?? 'missing'} (want ${d.expected})`).join(', ');
    throw new Error(`evidence-dep-drift: ${names}`);
  }
  return { ...EVIDENCE_DEPS };
}

function lazyRequireEvidenceDeps() {
  // Dev-only decoders are loaded lazily so tree/secrets modes (and CI
  // privacy steps without a full install) never touch them.
  return {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    yauzl: require('yauzl'),
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    sharp: require('sharp'),
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    tesseract: require('tesseract.js'),
  };
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evidence timeout: ${label}`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function evidenceTimeoutMs(fallback) {
  const raw = Number(process.env.TAA_EVIDENCE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return fallback;
}

/** Extract printable ASCII runs from binary buffers (trace payloads etc.). */
function extractPrintableRuns(buffer, minRun = 6) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    const c = buffer[i];
    const printable = (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d;
    if (printable) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      if (i - start >= minRun) {
        runs.push({ text: buffer.toString('utf8', start, i), offset: start });
      }
      start = -1;
    }
  }
  if (start !== -1 && buffer.length - start >= minRun) {
    runs.push({ text: buffer.toString('utf8', start, buffer.length), offset: start });
  }
  return runs;
}

function openZipBuffer(yauzl, buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (err, zipfile) => {
      if (err) reject(err);
      else resolve(zipfile);
    });
  });
}

function openZipPath(yauzl, abs) {
  return new Promise((resolve, reject) => {
    yauzl.open(abs, { lazyEntries: true, strictFileNames: true }, (err, zipfile) => {
      if (err) reject(err);
      else resolve(zipfile);
    });
  });
}

function readZipEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks = [];
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks, bytes)));
      stream.on('error', reject);
    });
  });
}

function drainZipEntries(zipfile, onEntry) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        // ignore close errors after settle
      }
      if (err) reject(err);
      else resolve();
    };
    zipfile.on('error', done);
    zipfile.on('end', () => done(null));
    zipfile.on('entry', (entry) => {
      Promise.resolve()
        .then(() => onEntry(entry))
        .then(() => {
          if (!settled) zipfile.readEntry();
        })
        .catch(done);
    });
    zipfile.readEntry();
  });
}

function classifyEvidenceError(message) {
  if (/encrypt/i.test(message)) return 'encrypted-archive';
  return 'decode-failure';
}

function isValidArchiveEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('\\')) return false;
  if (path.posix.isAbsolute(name)) return false;
  if (name.split('/').includes('..')) return false;
  return true;
}

async function createOcrEngine(tesseract, modelDir) {
  if (process.env.TAA_EVIDENCE_FAIL_OCR === '1') {
    throw new Error('ocr-failure: injected OCR failure');
  }
  const http = require('http');
  const server = http.createServer((req, res) => {
    try {
      const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
      const file = path.join(modelDir, rel);
      if (path.relative(modelDir, file).startsWith('..') && path.relative(modelDir, file) !== '') {
        res.writeHead(400);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': data.length });
        res.end(data);
      });
    } catch {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // ignore late response errors
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const serverAddress = server.address();
  if (serverAddress === null || typeof serverAddress === 'string') {
    throw new Error('ocr-failure: loopback model server address is unavailable');
  }
  const langPath = `http://127.0.0.1:${serverAddress.port}`;
  let worker = null;
  try {
    worker = await withTimeout(
      tesseract.createWorker('eng', tesseract.OEM.LSTM_ONLY, {
        langPath,
        gzip: true,
        cacheMethod: 'none',
      }),
      evidenceTimeoutMs(120000),
      'ocr-worker-init',
    );
  } catch (err) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`ocr-failure: ${err.message}`);
  }
  return {
    async recognize(pngBuffer) {
      if (process.env.TAA_EVIDENCE_FAIL_OCR === '1') {
        throw new Error('ocr-failure: injected OCR failure');
      }
      const { data } = await withTimeout(
        worker.recognize(pngBuffer),
        evidenceTimeoutMs(120000),
        'ocr-recognize',
      );
      return String(data && data.text ? data.text : '');
    },
    async close() {
      try {
        await worker.terminate();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

async function mainEvidence(root, outAbs) {
  const findings = [];
  const push = (rule, relPath, offset) => {
    findings.push({ rule, path: relPath, offset });
  };

  // Output must live outside the scanned root until PASS — otherwise the
  // report itself becomes scan input (and a secret echo chamber).
  const outRel = toPosix(path.relative(root, outAbs));
  if (outRel === '' || (!outRel.startsWith('../') && !path.isAbsolute(outRel))) {
    throw new Error('--out must resolve outside --root in evidence mode');
  }

  // Fail-closed preconditions: pinned decoders + tracked OCR model.
  try {
    verifyEvidenceDeps();
  } catch (err) {
    push('evidence-dep-drift', '.', 0);
    return finishEvidence(outAbs, findings, `audit-public-tree: ${err.message}`);
  }
  let modelInfo = null;
  try {
    modelInfo = verifyOcrModel();
  } catch (err) {
    push('ocr-model-drift', OCR_MODEL_REL, 0);
    return finishEvidence(outAbs, findings, `audit-public-tree: ${err.message}`);
  }

  const deps = lazyRequireEvidenceDeps();
  const account = { expandedBytes: 0, files: 0 };
  /** @type {{ recognize: (png: Buffer) => Promise<string>, close: () => Promise<void> } | null} */
  let ocr = null;
  const ocrModelDir = path.dirname(modelInfo.modelAbs);
  const ensureOcr = async () => {
    if (!ocr) {
      try {
        ocr = await createOcrEngine(deps.tesseract, ocrModelDir);
      } catch (err) {
        push('ocr-failure', '.', 0);
        throw err;
      }
    }
    return ocr;
  };

  const scanTextUnit = (displayPath, text, baseOffset) => {
    for (const hit of scanTextForSecrets(displayPath, text, {})) {
      push(hit.kind, displayPath, baseOffset + hit.offset);
    }
  };

  const scanBufferAsText = (displayPath, buffer) => {
    if (buffer.includes(0)) {
      for (const run of extractPrintableRuns(buffer)) {
        scanTextUnit(displayPath, run.text, run.offset);
      }
      return;
    }
    scanTextUnit(displayPath, buffer.toString('utf8'), 0);
  };

  const ocrImageBuffer = async (displayPath, buffer) => {
    let png = null;
    try {
      png = await withTimeout(
        deps.sharp(buffer).png().toBuffer(),
        evidenceTimeoutMs(60000),
        `sharp-decode:${displayPath}`,
      );
    } catch (err) {
      push('decode-failure', displayPath, 0);
      return;
    }
    let engine = null;
    try {
      engine = await ensureOcr();
    } catch {
      return; // ocr-failure already recorded
    }
    try {
      const text = await engine.recognize(png);
      scanTextUnit(displayPath, text, 0);
    } catch {
      push('ocr-failure', displayPath, 0);
    }
  };

  const scanZipBuffer = async (displayPath, buffer, depth) => {
    if (depth > EVIDENCE_LIMITS.maxDepth) {
      push('archive-limit', displayPath, 0);
      return;
    }
    let zipfile = null;
    try {
      zipfile = await withTimeout(
        openZipBuffer(deps.yauzl, buffer),
        evidenceTimeoutMs(60000),
        `zip-open:${displayPath}`,
      );
    } catch (err) {
      push(classifyEvidenceError(err.message), displayPath, 0);
      return;
    }
    await drainZipEntries(zipfile, async (entry) => {
      const name = entry.fileName;
      const nestedPath = `${displayPath}!/${name}`;
      if (/\/$/.test(name)) return;
      if (!isValidArchiveEntryName(name)) {
        push('path-traversal', nestedPath, 0);
        return;
      }
      account.files += 1;
      if (account.files > EVIDENCE_LIMITS.maxFiles) {
        push('archive-limit', nestedPath, 0);
        return;
      }
      let data = null;
      try {
        data = await withTimeout(
          readZipEntry(zipfile, entry),
          evidenceTimeoutMs(60000),
          `zip-entry:${nestedPath}`,
        );
      } catch (err) {
        push(classifyEvidenceError(err && err.message ? err.message : String(err)), nestedPath, 0);
        return;
      }
      account.expandedBytes += data.length;
      if (data.length > EVIDENCE_LIMITS.maxEntryBytes || account.expandedBytes > EVIDENCE_LIMITS.maxExpandedBytes) {
        push('archive-limit', nestedPath, 0);
        return;
      }
      const lower = name.toLowerCase();
      if (lower.endsWith('.zip')) {
        await scanZipBuffer(nestedPath, data, depth + 1);
        return;
      }
      const ext = path.posix.extname(lower);
      if (EVIDENCE_IMAGE_EXTS.has(ext)) {
        await ocrImageBuffer(nestedPath, data);
        return;
      }
      if (EVIDENCE_UNSUPPORTED_IMAGE_EXTS.has(ext)) {
        push('unsupported-image-type', nestedPath, 0);
        return;
      }
      if (EVIDENCE_UNSUPPORTED_ARCHIVE_EXTS.has(ext)) {
        push('unsupported-archive-type', nestedPath, 0);
        return;
      }
      scanBufferAsText(nestedPath, data);
    }).catch((err) => {
      push(classifyEvidenceError(err && err.message ? err.message : String(err)), displayPath, 0);
    });
  };

  const scanFileOnDisk = async (abs, relPosix) => {
    account.files += 1;
    if (account.files > EVIDENCE_LIMITS.maxFiles) {
      push('archive-limit', relPosix, 0);
      return;
    }
    const lower = relPosix.toLowerCase();
    const ext = path.posix.extname(lower);
    if (EVIDENCE_UNSUPPORTED_ARCHIVE_EXTS.has(ext)) {
      push('unsupported-archive-type', relPosix, 0);
      return;
    }
    if (lower.endsWith('.zip')) {
      let zipfile = null;
      try {
        zipfile = await withTimeout(
          openZipPath(deps.yauzl, abs),
          evidenceTimeoutMs(60000),
          `zip-open:${relPosix}`,
        );
      } catch (err) {
        push(classifyEvidenceError(err.message), relPosix, 0);
        return;
      }
      // Stream top-level entries through the same recursive budget: buffer
      // each entry once so nested ZIPs/OCR reuse one code path.
      await drainZipEntries(zipfile, async (entry) => {
        const name = entry.fileName;
        const nestedPath = `${relPosix}!/${name}`;
        if (/\/$/.test(name)) return;
        if (!isValidArchiveEntryName(name)) {
          push('path-traversal', nestedPath, 0);
          return;
        }
        account.files += 1;
        if (account.files > EVIDENCE_LIMITS.maxFiles) {
          push('archive-limit', nestedPath, 0);
          return;
        }
        let data = null;
        try {
          data = await withTimeout(
            readZipEntry(zipfile, entry),
            evidenceTimeoutMs(60000),
            `zip-entry:${nestedPath}`,
          );
        } catch (err) {
          push(classifyEvidenceError(err && err.message ? err.message : String(err)), nestedPath, 0);
          return;
        }
        account.expandedBytes += data.length;
        if (data.length > EVIDENCE_LIMITS.maxEntryBytes || account.expandedBytes > EVIDENCE_LIMITS.maxExpandedBytes) {
          push('archive-limit', nestedPath, 0);
          return;
        }
        const nestedLower = name.toLowerCase();
        if (nestedLower.endsWith('.zip')) {
          await scanZipBuffer(nestedPath, data, 2);
          return;
        }
        const nestedExt = path.posix.extname(nestedLower);
        if (EVIDENCE_IMAGE_EXTS.has(nestedExt)) {
          await ocrImageBuffer(nestedPath, data);
          return;
        }
        if (EVIDENCE_UNSUPPORTED_IMAGE_EXTS.has(nestedExt)) {
          push('unsupported-image-type', nestedPath, 0);
          return;
        }
        if (EVIDENCE_UNSUPPORTED_ARCHIVE_EXTS.has(nestedExt)) {
          push('unsupported-archive-type', nestedPath, 0);
          return;
        }
        scanBufferAsText(nestedPath, data);
      }).catch((err) => {
        push(classifyEvidenceError(err && err.message ? err.message : String(err)), relPosix, 0);
      });
      return;
    }
    if (EVIDENCE_IMAGE_EXTS.has(ext)) {
      let data = null;
      try {
        data = fs.readFileSync(abs);
      } catch {
        push('decode-failure', relPosix, 0);
        return;
      }
      if (data.length > EVIDENCE_LIMITS.maxEntryBytes) {
        push('archive-limit', relPosix, 0);
        return;
      }
      await ocrImageBuffer(relPosix, data);
      return;
    }
    if (EVIDENCE_UNSUPPORTED_IMAGE_EXTS.has(ext)) {
      push('unsupported-image-type', relPosix, 0);
      return;
    }
    let data = null;
    try {
      const st = fs.statSync(abs);
      if (st.size > EVIDENCE_LIMITS.maxTextBytes) {
        push('scan-limit', relPosix, 0);
        return;
      }
      data = fs.readFileSync(abs);
    } catch {
      push('decode-failure', relPosix, 0);
      return;
    }
    scanBufferAsText(relPosix, data);
  };

  const walkEvidence = async (absDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      push('decode-failure', toPosix(path.relative(root, absDir)) || '.', 0);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      const rel = toPosix(path.relative(root, abs));
      let st = null;
      try {
        st = fs.lstatSync(abs);
      } catch {
        push('decode-failure', rel, 0);
        continue;
      }
      if (st.isSymbolicLink()) {
        // Symlinks can escape the evidence root — fail closed, never follow.
        push('symlink-escape', rel, 0);
        continue;
      }
      if (st.isDirectory()) {
        await walkEvidence(abs);
      } else if (st.isFile()) {
        await scanFileOnDisk(abs, rel);
      } else {
        push('unsupported-entry', rel, 0);
      }
    }
  };

  try {
    const rootSt = fs.lstatSync(root);
    if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) {
      throw new Error('--root must be a real directory in evidence mode');
    }
    await walkEvidence(root);
  } catch (err) {
    if (err && err.message && err.message.startsWith('--root')) throw err;
    push('decode-failure', '.', 0);
  } finally {
    if (ocr) {
      try {
        await ocr.close();
      } catch {
        // ignore teardown errors; findings already recorded
      }
    }
  }
  return finishEvidence(outAbs, findings, null);
}

function finishEvidence(outAbs, findings, preface) {
  const sorted = findings
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.offset - b.offset));
  const report = { verdict: sorted.length === 0 ? 'PASS' : 'FAIL', findings: sorted };
  writeReport(outAbs, report);
  if (preface) console.error(preface);
  const byRule = {};
  for (const f of sorted) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  console.log(`audit-public-tree evidence verdict:${report.verdict} findings:${sorted.length}`);
  for (const [rule, count] of Object.entries(byRule).sort()) {
    console.log(`  evidence-rule: ${rule} x${count}`);
  }
  for (const f of sorted.slice(0, 50)) {
    console.log(`  evidence-hit: ${f.rule} ${f.path} @${f.offset}`);
  }
  return report.verdict;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`audit-public-tree: ${e.message}`);
    process.exit(2);
  }
  const root = path.resolve(args.root);
  const outAbs = path.resolve(args.out);
  const outRel = toPosix(path.relative(root, outAbs));

  if (args.mode === 'evidence') {
    let verdict = 'FAIL';
    try {
      verdict = await mainEvidence(root, outAbs);
    } catch (e) {
      console.error(`audit-public-tree: ${e.message}`);
      process.exit(2);
    }
    process.exit(verdict === 'PASS' ? 0 : 1);
  }

  if (args.mode === 'secrets') {
    let secretHits = [];
    try {
      secretHits = mainSecrets(root, outAbs, outRel);
    } catch (e) {
      console.error(`audit-public-tree: ${e.message}`);
      process.exit(2);
    }
    const verdict = secretHits.length === 0 ? 'PASS' : 'FAIL';
    writeReport(outAbs, { verdict, secretHits });
    console.log(`audit-public-tree secrets verdict:${verdict} secrets:${secretHits.length}`);
    for (const s of secretHits.slice(0, 50)) {
      console.log(`  secret-hit: ${s.file}:${s.line} (${s.kind})`);
    }
    process.exit(verdict === 'PASS' ? 0 : 1);
  }

  const baseline = path.resolve(args.baseline);
  const { excludedFound, hashMismatches, secretHits } = mainTree(root, baseline, outAbs, outRel);
  const verdict =
    excludedFound.length === 0 && hashMismatches.length === 0 && secretHits.length === 0
      ? 'PASS'
      : 'FAIL';
  const report = { verdict, excludedFound, hashMismatches, secretHits };

  writeReport(outAbs, report);

  console.log(
    `audit-public-tree verdict:${verdict} excluded:${excludedFound.length} mismatches:${hashMismatches.length} secrets:${secretHits.length}`,
  );
  for (const e of excludedFound) console.log(`  excluded-present: ${e}`);
  for (const m of hashMismatches) console.log(`  mismatch: ${m.file} (${m.reason})`);
  for (const s of secretHits) {
    console.log(`  secret-hit: ${s.file}:${s.line} (${s.kind}, tokenLen=${s.tokenLen})`);
  }

  process.exit(verdict === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`audit-public-tree: ${err && err.message ? err.message : err}`);
    process.exit(2);
  });
}

module.exports = {
  SCANNER_POLICY,
  ALLOWLIST,
  DENYLIST,
  GENERATED,
  SETTINGS_BACKUP_RE,
  scanTextForSecrets,
  treeScanExemptions,
  verifyOcrModel,
  verifyEvidenceDeps,
  ocrModelPaths,
};
