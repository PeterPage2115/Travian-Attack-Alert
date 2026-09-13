'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST = path.join(ROOT, 'test', 'script.test.cjs');
const ARTIFACTS = [
    'test/fixtures/acquisition/manifest.json',
    ...['members-60', 'members-59-incident', 'overview', 'reports-paginated', 'report-detail'].flatMap(name => [
        `test/fixtures/acquisition/${name}.html`, `test/fixtures/acquisition/golden/${name}.json`
    ])
];

const tasks = Object.freeze({
    1: {
        happy: { command: process.execPath, args: ['--test', '--test-name-pattern=sanitized acquisition fixtures|evidence runner self-test', TEST], artifacts: ARTIFACTS },
        failure: { command: process.execPath, args: ['-e', "const a=require('./test/fixtures/acquisition/sanitizer.cjs'); const r=require('./test/fixtures/stabilization/evidence-runner.cjs'); if (a.sanitizeHtml('<script>bad</script><div class=\\\"villageList\\\">token</div>', {routeRole:'non-authoritative',rejectionReason:'sentinel'}).includes('bad')) process.exit(1); try { r.resolveCase({task:999}); r.resolveCase({final:'UNKNOWN'}); process.exit(1); } catch { process.exit(0); }"], artifacts: [] }
    },
    2: {
        happy: { command: process.execPath, args: ['--test', '--test-name-pattern=conservation|net delta|incident accounting', TEST], artifacts: ['test/fixtures/stabilization/conservation-oracle.cjs', 'test/fixtures/acquisition/golden/members-59-incident.json'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=conservation negative', TEST], artifacts: [] }
    },
    3: {
        happy: { command: 'npx', args: ['playwright', 'test', '--config', 'test/e2e/playwright.config.ts', 'test/e2e/route-lease.spec.ts', '--project=chromium-1280', '--grep', 'canonical authority|serialized contenders', '--reporter=json'], artifacts: ['test/e2e/route-lease.spec.ts'] },
        failure: { command: 'npx', args: ['playwright', 'test', '--config', 'test/e2e/playwright.config.ts', 'test/e2e/route-lease.spec.ts', '--project=chromium-1280', '--grep', 'noncanonical inert|query rejected|stale term fenced|Web Locks unavailable', '--reporter=json'], artifacts: ['test/e2e/route-lease.spec.ts'] }
    },
    4: {
        happy: { command: process.execPath, args: ['-e', "const {spawnSync}=require('node:child_process'); const n=spawnSync(process.execPath,['--test','--test-name-pattern=member-table contract|member-table selection|tooltip parsing', 'test/script.test.cjs'],{stdio:'inherit'}); if(n.status!==0) process.exit(n.status); const p=spawnSync('npx',['playwright','test','--config','test/e2e/playwright.config.ts','test/e2e/readiness-late.spec.ts','--project=chromium-1280','--reporter=json'],{stdio:'inherit'}); process.exit(p.status||0);"], artifacts: ['test/fixtures/acquisition/members-60.html', 'test/fixtures/acquisition/members-59-incident.html', 'test/e2e/readiness-late.spec.ts'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=invalid and partial|duplicate ID conflict|conflicting tooltip|missing ID|member-table contract rejects', TEST], artifacts: ['test/fixtures/acquisition/golden/overview.json', 'test/fixtures/acquisition/golden/reports-paginated.json', 'test/fixtures/acquisition/golden/report-detail.json', '.omo/evidence/stabilizacja-akwizycji-atakow/task-4-matrix.json'] }
    },
    5: {
        happy: { command: process.execPath, args: ['--test', '--test-name-pattern=accepted scan planner|accepted scan commit|threshold.*baseline|Todo 5 accepted scan', TEST], artifacts: ['script.txt', 'test/script.test.cjs', '.omo/evidence/stabilizacja-akwizycji-atakow/task-5-manifest.json'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=failed monitor storage|stale term and capacity|accepted scan commit', TEST], artifacts: ['script.txt', 'test/script.test.cjs', '.omo/evidence/stabilizacja-akwizycji-atakow/task-5-manifest.json'] }
    },
    6: {
        happy: { command: process.execPath, args: ['--test', '--test-name-pattern=coalesce.*sourceEventIds|delivery accounting|injective normal identity|legacy active lineage|terminal compaction conservation', TEST], artifacts: ['script.txt', 'test/script.test.cjs', 'test/fixtures/stabilization/conservation-oracle.cjs', '.omo/evidence/stabilizacja-akwizycji-atakow/task-6-manifest.json'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=Todo 6 injective|Todo 6 delivery accounting|Todo 6 old envelopes', TEST], artifacts: ['script.txt', 'test/script.test.cjs', '.omo/evidence/stabilizacja-akwizycji-atakow/task-6-manifest.json'] }
    },
    7: {
        happy: { command: process.execPath, args: ['test/fixtures/stabilization/task-7.cjs'], artifacts: ['script.txt', 'test/script.test.cjs', 'test/e2e/discord-manual-fetch-timing.spec.ts'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=Task 7 rejection', TEST], artifacts: ['script.txt', 'test/script.test.cjs', 'test/e2e/discord-manual-fetch-timing.spec.ts'] }
    },
    8: {
        happy: { command: process.execPath, args: ['test/fixtures/stabilization/task-8.cjs'], artifacts: ['script.txt', 'test/script.test.cjs', 'test/fixtures/stabilization/task-8.cjs'] },
        failure: { command: process.execPath, args: ['test/fixtures/stabilization/task-8.cjs', '--failures'], artifacts: ['script.txt', 'test/script.test.cjs', 'test/fixtures/stabilization/task-8.cjs'] }
    },
    9: {
        happy: { command: process.execPath, args: ['--test', '--test-name-pattern=Todo 9 canonical|Todo 9 retains', TEST], artifacts: ['script.txt', 'test/script.test.cjs'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=Todo 9 rejects|Todo 9 retains', TEST], artifacts: ['script.txt', 'test/script.test.cjs'] }
    },
    10: {
        happy: { command: process.execPath, args: ['--test', '--test-name-pattern=count reconciliation|\\+8 for one player|coalesced multi-request|rejected scan reason|incident export', TEST], artifacts: ['script.txt', 'test/script.test.cjs', 'test/e2e/attack-panel.spec.ts'] },
        failure: { command: process.execPath, args: ['--test', '--test-name-pattern=diagnostics corrupted|incident redaction|incident export byte cap', TEST], artifacts: ['script.txt', 'test/script.test.cjs', 'test/e2e/attack-panel.spec.ts'] }
    },
    11: {
        happy: { command: process.execPath, args: ['-e', "const {spawnSync}=require('node:child_process'); for (const command of [['npm','run','build'],['npm','run','check:artifact'],['npm','run','check:types'],['npm','run','quality'],['npm','test']]) { const result=spawnSync(command[0],command.slice(1),{cwd:process.cwd(),stdio:'inherit',shell:false}); if(result.status!==0) process.exit(result.status||1); }"], artifacts: ['script.txt', 'src/browser-entry.js', 'tools/build.cjs', 'tools/check-artifact.cjs', 'tools/quality.cjs', 'metadata.json', 'module-manifest.json', 'package-lock.json'] },
        failure: { command: process.execPath, args: ['test/fixtures/stabilization/task-11.cjs'], artifacts: ['script.txt', 'module-manifest.json'] }
    },
    12: {
        happy: { command: process.execPath, args: ['test/fixtures/stabilization/task-12.cjs'], artifacts: ['src/constants.js', 'src/text.js', 'src/storage.js', 'src/lease.js', 'src/route.js', 'src/parser.js', 'src/snapshot.js', 'src/envelope.js', 'src/migration.js', 'test/script.test.cjs'] },
        failure: { command: process.execPath, args: ['test/fixtures/stabilization/task-12.cjs', '--failures'], artifacts: ['tools/build.cjs', 'tools/quality.cjs', 'tools/check-artifact.cjs'] }
    },
    13: {
        happy: { command: process.execPath, args: ['test/fixtures/stabilization/task-13.cjs'], artifacts: ['src/discord.js', 'src/transport.js', 'src/dispatch.js', 'src/conservation.js', 'src/diagnostics.js', 'test/fixtures/stabilization/task-13.cjs'] },
        failure: { command: process.execPath, args: ['test/fixtures/stabilization/task-13.cjs', '--failures'], artifacts: ['script.txt', 'test/script.test.cjs'] }
    },
    14: {
        happy: { command: process.execPath, args: ['test/fixtures/stabilization/task-14.cjs'], artifacts: ['src/panel.js', 'src/boot.js', 'src/browser-entry.js', 'README.md', 'DESIGN.md', 'script.txt', 'test/fixtures/stabilization/task-14.cjs'] },
        failure: { command: process.execPath, args: ['test/fixtures/stabilization/task-14.cjs', '--failures'], artifacts: ['README.md', 'DESIGN.md'] }
    }
});

const F1 = path.join(ROOT, 'test', 'fixtures', 'stabilization', 'f1-audit.cjs');
const F2 = path.join(ROOT, 'test', 'fixtures', 'stabilization', 'f2-audit.cjs');
const F3 = path.join(ROOT, 'test', 'fixtures', 'stabilization', 'f3-audit.cjs');
const F4 = path.join(ROOT, 'test', 'fixtures', 'stabilization', 'f4-audit.cjs');
const finals = Object.freeze({
    F1: {
        happy: { command: process.execPath, args: [F1, '--happy'], artifacts: ['test/fixtures/stabilization/f1-audit.cjs', 'test/fixtures/stabilization/conservation-oracle.cjs', 'README.md', 'DESIGN.md'] },
        failure: { command: process.execPath, args: [F1, '--failure'], artifacts: [] }
    },
    F2: {
        happy: { command: process.execPath, args: [F2, '--happy'], artifacts: ['test/fixtures/stabilization/f2-audit.cjs', 'script.txt', 'metadata.json', 'module-manifest.json'] },
        failure: { command: process.execPath, args: [F2, '--failure'], artifacts: [] }
    },
    F3: {
        happy: { command: process.execPath, args: [F3, '--happy'], artifacts: ['test/fixtures/stabilization/f3-audit.cjs', 'test/e2e/f3-browser-qa.spec.ts', 'script.txt'] },
        failure: { command: process.execPath, args: [F3, '--failure'], artifacts: ['test/fixtures/stabilization/f3-audit.cjs', 'test/e2e/f3-browser-qa.spec.ts'] }
    },
    F4: {
        happy: { command: process.execPath, args: [F4, '--happy'], artifacts: ['test/fixtures/stabilization/f4-audit.cjs', 'script.txt', 'README.md', 'DESIGN.md'] },
        failure: { command: process.execPath, args: [F4, '--failure'], artifacts: ['test/fixtures/stabilization/f4-audit.cjs'] }
    }
});
module.exports = { tasks, finals };
