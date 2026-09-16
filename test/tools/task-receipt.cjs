'use strict';

const fs = require('node:fs');
const path = require('node:path');
const evidence = require('./plan-evidence-audit.cjs');

function assertHex(value, length, label) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)) throw new Error(`invalid ${label}`);
}

function buildReceipt(input) {
  const identity = input.planIdentity;
  evidence.verifyPlanIdentity(identity);
  if (input.attemptId !== identity.attemptId) throw new Error('attempt id does not match plan identity');
  if (!Number.isInteger(input.task) || input.task < 1 || input.task > 24) throw new Error('invalid task number');
  assertHex(input.behaviorOracleSha256, 64, 'behavior oracle digest');
  assertHex(input.preTree, 40, 'pre-tree');
  assertHex(input.postTree, 40, 'post-tree');
  const commandCount = evidence.verifyCommands(input.commands);
  const reportCount = evidence.verifyReports(input.reports, input.attemptRoot);
  const receipt = {
    schemaVersion: 1, task: input.task, attemptId: input.attemptId,
    planIdentitySha256: evidence.sha256(evidence.canonical(identity)),
    behaviorOracleSha256: input.behaviorOracleSha256,
    preTree: input.preTree, postTree: input.postTree,
    commandsSha256: evidence.sha256(evidence.canonical(input.commands)),
    reportsSha256: evidence.sha256(evidence.canonical(input.reports)),
    commandCount, reportCount, verdict: 'PASS',
  };
  receipt.receiptSha256 = evidence.sha256(evidence.canonical(receipt));
  return receipt;
}

function verifyReceipt(receipt) {
  if (!receipt || receipt.verdict !== 'PASS') throw new Error('receipt is not PASS');
  const copy = { ...receipt }; delete copy.receiptSha256;
  if (evidence.sha256(evidence.canonical(copy)) !== receipt.receiptSha256) throw new Error('receipt digest mismatch');
  return true;
}

function parse(argv) {
  const command = argv[0]; const options = {};
  for (let index = 1; index < argv.length; index += 2) options[argv[index].slice(2)] = argv[index + 1];
  return { command, options };
}

if (require.main === module) {
  try {
    const { command, options } = parse(process.argv.slice(2));
    if (command === 'verify') {
      verifyReceipt(evidence.readJsonNoFollow(path.resolve(options.receipt)));
      process.stdout.write('{"verdict":"PASS"}\n');
    } else if (command === 'emit') {
      const planIdentityPath = path.resolve(options['plan-identity']);
      const attemptRoot = path.dirname(planIdentityPath);
      const output = evidence.resolveInside(attemptRoot, path.relative(attemptRoot, path.resolve(options.out)));
      const receipt = buildReceipt({ task: Number(options.task), attemptId: options['attempt-id'], behaviorOracleSha256: options['behavior-oracle-sha256'], preTree: options['pre-tree'], postTree: options['post-tree'], planIdentity: evidence.readJsonNoFollow(planIdentityPath), commands: evidence.readJsonNoFollow(path.resolve(options.commands)), reports: evidence.readJsonNoFollow(path.resolve(options.reports)), attemptRoot });
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const temporary = `${output}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(temporary, output);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else throw new Error('usage: task-receipt.cjs emit|verify');
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}

module.exports = { buildReceipt, verifyReceipt };
