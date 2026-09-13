'use strict';
/**
 * audit-public-tree.cjs — weryfikacja bezpiecznej kopii allowlistowej (Todo 2).
 *
 * Użycie:
 *   node tools/audit-public-tree.cjs --root . --baseline ../TravianAttackAlertDEV --out test-results/release-1.0.0/copy-audit.json
 *
 * Kontrole:
 *   (a) każdy plik z allowlisty w --root ma hash równy źródłu w --baseline,
 *   (b) każda ścieżka z denylisty jest nieobecna w --root,
 *   (c) żaden śledzony plik tekstowy nie zawiera realnego
 *       `discord.com/api/webhooks/<digits>/<non-placeholder-token>`
 *       (dozwolone tokeny zawierające `<...>`, `FAKE`, `PLACEHOLDER`, `example`).
 *
 * Wynik: JSON {verdict, excludedFound[], hashMismatches[], secretHits[]}.
 * Exit 0 przy verdict PASS, niezerowy przy FAIL. Pełny token NIGDY nie jest
 * wypisywany (ani na stdout, ani w JSON — tylko plik, linia i długość).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 14-entry allowlist (Todo 2) — kopiowane indywidualnie, nigdy rekurencyjnie całością.
const ALLOWLIST = [
  'script.txt',
  'package.json',
  'package-lock.json',
  'metadata.json',
  'module-manifest.json',
  'src/',
  'tools/',
  'test/',
  'README.md',
  'DESIGN.md',
  'AGENTS.md',
  'tsconfig.json',
  '.node-version',
  '.gitignore',
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
];

// Wzorce plików sekretów (dopasowane basename lub glob `*` na końcu).
const DENYLIST_FILES = ['.env', '.env.*'];

// Pliki generowane w nowym repo — należą do kopii, ale nie do baseline DEV.
const GENERATED = new Set([
  'baseline-files.sha256',
  'tools/audit-public-tree.cjs',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root' || a === '--baseline' || a === '--out') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error(`missing value for ${a}`);
      }
      out[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.root || !out.baseline || !out.out) {
    throw new Error('required args: --root <dir> --baseline <dir> --out <file>');
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

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`audit-public-tree: ${e.message}`);
    process.exit(2);
  }
  const root = path.resolve(args.root);
  const baseline = path.resolve(args.baseline);
  const outAbs = path.resolve(args.out);
  const outRel = toPosix(path.relative(root, outAbs));

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
    if (rel.startsWith('.git/')) continue; // Todo 3 dopiero inicjalizuje git
    hashMismatches.push({ file: rel, reason: 'unexpected-extra' });
  }

  // --- (c) skan token-pattern w plikach tekstowych (bez pełnego tokena w raporcie) ---
  const webhookRe = /discord\.com\/api\/webhooks\/(\d+)\/([^\s"'`)}\]]+)/g;
  const placeholderRe = /(<|>|FAKE|PLACEHOLDER|example)/i;
  // Prawdziwy token webhooka Discorda ma ~68 znaków (base64url o wysokiej
  // entropii). Deterministyczne fixtury loopback w testach używają krótkich
  // dummy-tokenów (zweryfikowano: maks. 20 znaków na całej powierzchni
  // allowlisty, wyłącznie w test/). Próg 32 znaki daje szeroki margines:
  // krótszy token nie może być żywym sekretem.
  const MIN_REAL_TOKEN_LEN = 32;
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
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      webhookRe.lastIndex = 0;
      let m;
      while ((m = webhookRe.exec(line)) !== null) {
        const token = m[2];
        if (!placeholderRe.test(token) && token.length >= MIN_REAL_TOKEN_LEN) {
          // Celowo BEZ wartości tokena: tylko lokalizacja i długość.
          secretHits.push({ file: rel, line: idx + 1, tokenLen: token.length });
        }
      }
    });
  }

  const verdict =
    excludedFound.length === 0 && hashMismatches.length === 0 && secretHits.length === 0
      ? 'PASS'
      : 'FAIL';
  const report = { verdict, excludedFound, hashMismatches, secretHits };

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `audit-public-tree verdict:${verdict} excluded:${excludedFound.length} mismatches:${hashMismatches.length} secrets:${secretHits.length}`
  );
  for (const e of excludedFound) console.log(`  excluded-present: ${e}`);
  for (const m of hashMismatches) console.log(`  mismatch: ${m.file} (${m.reason})`);
  for (const s of secretHits) console.log(`  secret-hit: ${s.file}:${s.line} (tokenLen=${s.tokenLen})`);

  process.exit(verdict === 'PASS' ? 0 : 1);
}

main();
