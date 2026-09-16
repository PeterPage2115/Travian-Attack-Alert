'use strict';

const fs = require('node:fs');
const { verifyCheckpoint } = require('./task-checkpoint.cjs');

function verifyFinalReview({ receipts, preTree, requiredTasks = [] }) {
  const checkpoint = verifyCheckpoint(receipts, preTree);
  const present = new Set(receipts.map(receipt => receipt.task));
  for (const task of requiredTasks) if (!present.has(task)) throw new Error(`missing required task receipt ${task}`);
  if (receipts.some(receipt => receipt.verdict !== 'PASS')) throw new Error('non-PASS task receipt');
  return { ...checkpoint, requiredTasks: [...requiredTasks].sort((a, b) => a - b) };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const preTree = args[args.indexOf('--pre-tree') + 1];
    const required = (args[args.indexOf('--required') + 1] || '').split(',').filter(Boolean).map(Number);
    const receiptFiles = args.slice(args.indexOf('--receipts') + 1).filter(value => !value.startsWith('--'));
    process.stdout.write(`${JSON.stringify(verifyFinalReview({ receipts: receiptFiles.map(file => JSON.parse(fs.readFileSync(file, 'utf8'))), preTree, requiredTasks: required }))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { verifyFinalReview };
