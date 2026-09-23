'use strict';
/**
 * seal-evidence.cjs — deterministic evidence ZIP + digest manifest (Task 6).
 *
 * Why: CI used to upload the mutable `test-results/` directory directly, so
 * anything that mutated that directory between the browser run and the upload
 * (or was never scanned at all) could ship as "evidence". This tool freezes
 * the complete tree into ONE byte-deterministic ZIP outside the input tree,
 * records a per-entry + archive SHA-256 manifest, and can re-verify those
 * digests immediately before upload.
 *
 * Seal:
 *   node tools/seal-evidence.cjs --input <dir> --archive <outside.zip> --manifest <outside.json>
 *
 * Verify (recompute + compare, fail closed):
 *   node tools/seal-evidence.cjs --verify --archive <zip> --manifest <json>
 *
 * Determinism contract:
 *   - entries sorted by normalized posix relative path (code-unit order),
 *   - STORE method (no compressor-version drift),
 *   - fixed DOS timestamp (1980-01-01), fixed flags/version/external attrs,
 *   - no extra fields, no comments, no data descriptors, no absolute paths,
 *   - manifest carries no timestamps or absolute paths.
 *   => identical input bytes produce an identical ZIP and manifest.
 *
 * Fail-closed contract:
 *   - symlinks and non-regular entries are refused, never followed,
 *   - files are opened with O_NOFOLLOW and fstat-verified as regular,
 *   - archive/manifest must resolve outside the input tree,
 *   - the manifest archive SHA-256 + byte count + entry list are re-checked
 *     by --verify, which also recomputes every stored entry payload's SHA-256
 *     and compares it with the manifest value; any drift is a nonzero exit.
 *   - --verify rejects malformed manifest entries/hashes, duplicate paths and
 *     ZIP features the deterministic writer cannot produce (multi-disk, ZIP64,
 *     encryption, data descriptors, non-STORE methods).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOS_DATE = 0x0021; // 1980-01-01 (earliest representable DOS date)
const DOS_TIME = 0x0000;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | 20; // Unix host, PKZIP 2.0
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isOutside(rootAbs, targetAbs) {
  const rel = path.relative(rootAbs, targetAbs);
  return rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
}

class SealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SealError';
    this.exitCode = 2;
  }
}

function fail(message) {
  return new SealError(message);
}

/**
 * Validate one archive entry name: relative, posix, no traversal.
 * @param {string} rel
 * @returns {string}
 */
function normalizeEntryPath(rel) {
  const posix = toPosix(rel);
  const segments = posix.split('/');
  if (
    posix.length === 0 ||
    posix.includes('\\') ||
    path.posix.isAbsolute(posix) ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw fail(`unsafe archive entry path: ${JSON.stringify(rel)}`);
  }
  return posix;
}

/**
 * Read a regular file without following symlinks (O_NOFOLLOW + fstat check).
 * @param {string} abs
 * @param {string} rel
 * @returns {Buffer}
 */
function readRegularFile(abs, rel) {
  let fd = null;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fail(`refusing non-regular entry: ${rel}`);
    return fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof SealError) throw error;
    throw fail(`cannot read ${rel}: ${error && error.message ? error.message : error}`);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors; the read result already decided the outcome
      }
    }
  }
}

/**
 * Walk the input tree (no symlink following) and return sorted file records.
 * @param {string} inputAbs
 * @returns {Array<{rel: string, abs: string, data: Buffer}>}
 */
function collectTree(inputAbs) {
  const entries = [];
  const walk = (absDir, relDir) => {
    const dirents = fs.readdirSync(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(absDir, dirent.name);
      const rel = normalizeEntryPath(`${relDir}${dirent.name}`);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) throw fail(`refusing symlink (never followed): ${rel}`);
      if (st.isDirectory()) {
        walk(abs, `${rel}/`);
        continue;
      }
      if (!st.isFile()) throw fail(`refusing non-regular entry: ${rel}`);
      entries.push({ rel, abs, data: readRegularFile(abs, rel) });
    }
  };
  walk(inputAbs, '');
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

/**
 * Build a deterministic STORE-method ZIP from sorted entry records.
 * @param {Array<{rel: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  if (entries.length > UINT16_MAX) throw fail('too many entries for a classic ZIP archive');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.rel, 'utf8');
    const size = entry.data.length;
    if (size > UINT32_MAX) throw fail(`entry too large for a classic ZIP archive: ${entry.rel}`);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, entry.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(VERSION_MADE_BY, 4);
    cd.writeUInt16LE(VERSION_NEEDED, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(METHOD_STORE, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra field length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(EXTERNAL_ATTRS, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + size;
    if (offset > UINT32_MAX) throw fail('archive too large for a classic ZIP archive');
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...parts, centralBuffer, eocd]);
}

/**
 * Parse the ZIP end-of-central-directory + central directory (no extraction).
 * Fails closed on structures the deterministic writer cannot produce
 * (multi-disk, ZIP64, encryption, data descriptors, non-STORE methods) and on
 * unsafe entry names.
 * @param {Buffer} buffer
 * @returns {{entries: Array<{path: string, crc32: number, bytes: number, method: number, flags: number, localHeaderOffset: number}>, centralOffset: number}}
 */
function parseZipDirectory(buffer) {
  if (buffer.length < 22) throw fail('not a ZIP archive: shorter than the end-of-central-directory record');
  let eocd = -1;
  const minEocd = Math.max(0, buffer.length - 22 - UINT16_MAX);
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw fail('not a ZIP archive: end-of-central-directory record missing');
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    throw fail('unsupported ZIP feature: multi-disk archive');
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    throw fail('unsupported ZIP feature: ZIP64 archive');
  }
  if (centralSize === UINT32_MAX || centralOffset === UINT32_MAX) {
    throw fail('unsupported ZIP feature: ZIP64 archive');
  }
  if (centralOffset + centralSize > buffer.length) throw fail('corrupt ZIP: central directory out of bounds');
  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIG) {
      throw fail('corrupt ZIP: invalid central directory entry');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const bytes = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskNumberStart = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw fail('corrupt ZIP: central directory entry out of bounds');
    }
    if (flags & FLAG_ENCRYPTED) throw fail('unsupported ZIP feature: encrypted entry');
    if (flags & FLAG_DATA_DESCRIPTOR) throw fail('unsupported ZIP feature: data descriptor');
    if (method !== METHOD_STORE) throw fail(`unsupported ZIP feature: compression method ${method}`);
    if (diskNumberStart !== 0) throw fail('unsupported ZIP feature: multi-disk entry');
    if (compressedBytes !== bytes) throw fail('corrupt ZIP: STORE entry sizes disagree');
    if (bytes === UINT32_MAX || localHeaderOffset === UINT32_MAX) {
      throw fail('unsupported ZIP feature: ZIP64 archive');
    }
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ path: normalizeEntryPath(name), crc32: crc, bytes, method, flags, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, centralOffset };
}

/**
 * Parse the ZIP central directory (array view over {@link parseZipDirectory}).
 * @param {Buffer} buffer
 * @returns {Array<{path: string, crc32: number, bytes: number, method: number, flags: number, localHeaderOffset: number}>}
 */
function readZipCentralDirectory(buffer) {
  return parseZipDirectory(buffer).entries;
}

/**
 * Extract one entry's stored payload using the validated central-directory
 * metadata (offset + byte count); the local header only locates name/extra.
 * @param {Buffer} buffer
 * @param {{path: string, bytes: number, localHeaderOffset: number}} entry
 * @param {number} centralOffset
 * @returns {Buffer}
 */
function readStoredPayload(buffer, entry, centralOffset) {
  const at = entry.localHeaderOffset;
  if (at + 30 > centralOffset || buffer.readUInt32LE(at) !== ZIP_LOCAL_SIG) {
    throw fail(`corrupt ZIP: invalid local file header for ${entry.path}`);
  }
  const method = buffer.readUInt16LE(at + 8);
  if (method !== METHOD_STORE) {
    throw fail(`unsupported ZIP feature: compression method ${method} for ${entry.path}`);
  }
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.bytes;
  if (dataEnd > centralOffset) {
    throw fail(`corrupt ZIP: entry payload out of bounds for ${entry.path}`);
  }
  return buffer.subarray(dataStart, dataEnd);
}

function atomicWrite(abs, buffer) {
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, abs);
}

/**
 * Seal a directory into a deterministic ZIP + manifest.
 * @param {{input: string, archive: string, manifest: string}} options
 * @returns {{archive: string, manifest: string, archiveSha256: string, archiveBytes: number, entryCount: number}}
 */
function sealTree(options) {
  const inputAbs = path.resolve(options.input);
  const archiveAbs = path.resolve(options.archive);
  const manifestAbs = path.resolve(options.manifest);
  if (!isOutside(inputAbs, archiveAbs)) throw fail('--archive must resolve outside --input');
  if (!isOutside(inputAbs, manifestAbs)) throw fail('--manifest must resolve outside --input');

  let inputStat = null;
  try {
    inputStat = fs.lstatSync(inputAbs);
  } catch (error) {
    throw fail(`--input is not readable: ${error && error.message ? error.message : error}`);
  }
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) {
    throw fail('--input must be a real directory (symlinks are never followed)');
  }

  const entries = collectTree(inputAbs);
  const zip = buildZip(entries);
  const manifest = {
    schemaVersion: 1,
    archive: path.basename(archiveAbs),
    archiveSha256: sha256(zip),
    archiveBytes: zip.length,
    entryCount: entries.length,
    entries: entries.map(entry => ({
      path: entry.rel,
      bytes: entry.data.length,
      sha256: sha256(entry.data),
    })),
  };
  fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
  fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
  atomicWrite(archiveAbs, zip);
  atomicWrite(manifestAbs, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return {
    archive: archiveAbs,
    manifest: manifestAbs,
    archiveSha256: manifest.archiveSha256,
    archiveBytes: manifest.archiveBytes,
    entryCount: manifest.entryCount,
  };
}

/**
 * Recompute + compare the sealed archive against its manifest. Fail closed.
 * @param {{archive: string, manifest: string}} options
 * @returns {{verdict: 'PASS', archive: string, archiveSha256: string, archiveBytes: number, entryCount: number}}
 */
function verifySealedArchive(options) {
  const archiveAbs = path.resolve(options.archive);
  const manifestAbs = path.resolve(options.manifest);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  } catch (error) {
    throw fail(`cannot read manifest: ${error && error.message ? error.message : error}`);
  }
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw fail('unsupported manifest schema');
  }
  if (typeof manifest.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256)) {
    throw fail('manifest archiveSha256 is missing or malformed');
  }
  if (!Number.isInteger(manifest.archiveBytes) || manifest.archiveBytes < 0) {
    throw fail('manifest archiveBytes is missing or malformed');
  }
  if (manifest.archive !== path.basename(archiveAbs)) {
    throw fail(`manifest is bound to a different archive: ${manifest.archive}`);
  }
  const archiveStat = fs.lstatSync(archiveAbs);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw fail('archive must be a regular file');
  const buffer = fs.readFileSync(archiveAbs);
  if (buffer.length !== manifest.archiveBytes) {
    throw fail(`archive size mismatch: manifest ${manifest.archiveBytes} bytes, actual ${buffer.length}`);
  }
  const actualSha256 = sha256(buffer);
  if (actualSha256 !== manifest.archiveSha256) {
    throw fail(`archive digest mismatch: manifest ${manifest.archiveSha256}, actual ${actualSha256}`);
  }
  const { entries: central, centralOffset } = parseZipDirectory(buffer);
  const manifestEntries = manifest.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw fail(`malformed manifest entry at index ${index}`);
    }
    if (typeof entry.path !== 'string') throw fail(`malformed manifest entry path at index ${index}`);
    const entryPath = normalizeEntryPath(entry.path);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw fail(`malformed manifest byte count for entry ${entryPath}`);
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw fail(`malformed manifest sha256 for entry ${entryPath}`);
    }
    return { path: entryPath, bytes: entry.bytes, sha256: entry.sha256 };
  });
  const manifestPaths = new Set();
  for (const entry of manifestEntries) {
    if (manifestPaths.has(entry.path)) throw fail(`duplicate manifest entry path: ${entry.path}`);
    manifestPaths.add(entry.path);
  }
  const centralPaths = new Set();
  for (const entry of central) {
    if (centralPaths.has(entry.path)) throw fail(`duplicate archive entry path: ${entry.path}`);
    centralPaths.add(entry.path);
  }
  manifestEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const centralEntries = central
    .map(entry => ({ path: entry.path, bytes: entry.bytes, localHeaderOffset: entry.localHeaderOffset }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (manifest.entryCount !== manifestEntries.length || centralEntries.length !== manifestEntries.length) {
    throw fail(
      `entry count mismatch: manifest ${manifestEntries.length}, archive ${centralEntries.length}`,
    );
  }
  for (let i = 0; i < manifestEntries.length; i += 1) {
    const declared = manifestEntries[i];
    const actual = centralEntries[i];
    if (declared.path !== actual.path || declared.bytes !== actual.bytes) {
      throw fail(`entry mismatch: manifest ${declared.path} (${declared.bytes}B), archive ${actual.path} (${actual.bytes}B)`);
    }
    const actualEntrySha256 = sha256(readStoredPayload(buffer, actual, centralOffset));
    if (actualEntrySha256 !== declared.sha256) {
      throw fail(`entry digest mismatch: ${declared.path} manifest ${declared.sha256}, actual ${actualEntrySha256}`);
    }
  }
  return {
    verdict: 'PASS',
    archive: archiveAbs,
    archiveSha256: actualSha256,
    archiveBytes: buffer.length,
    entryCount: centralEntries.length,
  };
}

function parseArgs(argv) {
  const out = { verify: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') {
      out.verify = true;
      continue;
    }
    if (arg === '--input' || arg === '--archive' || arg === '--manifest') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw fail(`missing value for ${arg}`);
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    throw fail(`unknown arg: ${arg}`);
  }
  if (!out.archive || !out.manifest) throw fail('required args: --archive <file.zip> --manifest <file.json>');
  if (!out.verify && !out.input) throw fail('required args: --input <dir> --archive <file.zip> --manifest <file.json>');
  if (out.verify && out.input) throw fail('--input does not apply to --verify');
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.verify) {
    let result = null;
    try {
      result = verifySealedArchive({ archive: args.archive, manifest: args.manifest });
    } catch (error) {
      console.error(`seal-evidence: verify FAIL ${error && error.message ? error.message : error}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    return;
  }
  const result = sealTree({ input: args.input, archive: args.archive, manifest: args.manifest });
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`seal-evidence: ${error && error.message ? error.message : error}`);
    process.exit(error && error.exitCode ? error.exitCode : 2);
  }
}

module.exports = {
  sealTree,
  verifySealedArchive,
  buildZip,
  readZipCentralDirectory,
  crc32,
  normalizeEntryPath,
  parseArgs,
};
