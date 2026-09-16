'use strict';

const { verifyReceipt } = require('./task-receipt.cjs');

function verifyCheckpoint(receipts, expectedPreTree) {
  if (!Array.isArray(receipts) || receipts.length < 1) throw new Error('checkpoint has no receipts');
  let tree = expectedPreTree;
  let previousTask = 0;
  for (const receipt of receipts) {
    verifyReceipt(receipt);
    if (receipt.task <= previousTask) throw new Error('receipt tasks are not strictly increasing');
    if (receipt.preTree !== tree) throw new Error(`tree discontinuity before task ${receipt.task}`);
    previousTask = receipt.task; tree = receipt.postTree;
  }
  return { verdict: 'PASS', tasks: receipts.length, postTree: tree };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const pre = args[args.indexOf('--pre-tree') + 1];
    const files = args.slice(args.indexOf('--receipts') + 1).filter(value => !value.startsWith('--'));
    const fs = require('node:fs');
    process.stdout.write(`${JSON.stringify(verifyCheckpoint(files.map(file => JSON.parse(fs.readFileSync(file, 'utf8'))), pre))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { verifyCheckpoint };
