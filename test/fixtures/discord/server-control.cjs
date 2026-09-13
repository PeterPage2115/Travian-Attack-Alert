'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_PATH = path.join(__dirname, 'server.cjs');
const MAX_GUARDIAN_AGE_MS = 600000;

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--guardian') {
            options.guardian = true;
        } else if (argument === '--self-test') {
            options.selfTest = true;
        } else if (argument.startsWith('--')) {
            const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
            options[key] = value;
        } else if (!options.action) {
            options.action = argument;
        } else {
            throw new Error(`unexpected argument: ${argument}`);
        }
    }
    return options;
}

function absolutePath(value, optionName) {
    if (!value) throw new Error(`${optionName} is required`);
    return path.resolve(value);
}

function positiveInteger(value, name) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
    return number;
}

function ensureParent(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readPid(pidPath) {
    try {
        const raw = fs.readFileSync(pidPath, 'utf8').trim();
        if (!/^\d+$/.test(raw)) return null;
        const pid = Number(raw);
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;
        process.kill(pid, 0);
        return pid;
    } catch (_) {
        return null;
    }
}

function pidFileValue(pidPath) {
    try {
        const raw = fs.readFileSync(pidPath, 'utf8').trim();
        return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
    } catch (_) {
        return null;
    }
}

function removeFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch (error) {
        return error.code === 'ENOENT';
    }
}

function portProbe(port, requestPath = '/') {
    return new Promise(resolve => {
        const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, timeout: 500 }, response => {
            response.resume();
            response.once('end', () => resolve(response.statusCode === 200));
        });
        request.once('error', () => resolve(false));
        request.once('timeout', () => {
            request.destroy();
            resolve(false);
        });
    });
}

function portIsClosed(port) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        const done = value => {
            socket.destroy();
            resolve(value);
        };
        socket.once('connect', () => done(false));
        socket.once('error', () => done(true));
        socket.setTimeout(500, () => done(true));
    });
}

async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return await predicate();
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    try { child.kill('SIGTERM'); } catch (_) { return true; }
    if (await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 5000, 50)) return true;
    try { child.kill('SIGKILL'); } catch (_) { return child.exitCode !== null; }
    return await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 1000, 50);
}

function writePidAtomically(pidPath, pid) {
    ensureParent(pidPath);
    const temporary = `${pidPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${pid}\n`, { mode: 0o600 });
    fs.renameSync(temporary, pidPath);
    if (pidFileValue(pidPath) !== pid) throw new Error('guardian PID validation failed');
    try { process.kill(pid, 0); } catch (_) { throw new Error('guardian PID is not active'); }
}

function lifecycleOptions(options, command) {
    const port = positiveInteger(options.port, '--port');
    const pidPath = absolutePath(options.pid, '--pid');
    const sentinelPath = absolutePath(options.sentinel, '--sentinel');
    const terminalPath = absolutePath(options.terminal, '--terminal');
    const logPath = options.log ? absolutePath(options.log, '--log') : null;
    if (command === 'start' && !logPath) throw new Error('--log is required for start');
    return { port, pidPath, sentinelPath, terminalPath, logPath };
}

async function guardian(options) {
    const controls = lifecycleOptions(options, 'start');
    const serverPidMarker = `${controls.logPath}.server-pid`;
    let reason = 'stop-requested';
    let serverChild = null;
    let finished = false;
    let finishResolve;
    const finishedPromise = new Promise(resolve => { finishResolve = resolve; });
    const requestFinish = nextReason => {
        if (finished) return;
        if (nextReason) reason = nextReason;
        finished = true;
        finishResolve();
    };

    process.once('SIGINT', () => requestFinish('signal'));
    process.once('SIGTERM', () => requestFinish('signal'));
    process.once('uncaughtException', error => {
        try { fs.appendFileSync(controls.logPath, `${error.stack || error}\n`); } catch (_) { /* best effort */ }
        requestFinish('child-failure');
    });
    process.once('unhandledRejection', error => {
        try { fs.appendFileSync(controls.logPath, `${error && error.stack ? error.stack : error}\n`); } catch (_) { /* best effort */ }
        requestFinish('child-failure');
    });

    let logHandle;
    try {
        ensureParent(controls.logPath);
        logHandle = fs.openSync(controls.logPath, 'a');
        writePidAtomically(controls.pidPath, process.pid);
        serverChild = spawn(process.execPath, [SERVER_PATH], {
            env: { ...process.env, TAA_DISCORD_FIXTURE_SERVER: '1', PORT: String(controls.port) },
            stdio: ['ignore', logHandle, logHandle]
        });
        fs.writeFileSync(serverPidMarker, `${serverChild.pid}\n`, { mode: 0o600 });
        serverChild.once('exit', () => {
            if (!finished) requestFinish('child-failure');
        });
        const ready = await waitUntil(
            () => portProbe(controls.port, '/discord-preview-payloads'),
            10000,
            100
        );
        if (!ready && !finished) requestFinish('child-failure');
        if (ready && !finished) {
            const poll = setInterval(() => {
                if (fs.existsSync(controls.sentinelPath)) requestFinish('stop-requested');
            }, 100);
            const timeout = setTimeout(() => requestFinish('timeout'), MAX_GUARDIAN_AGE_MS);
            await finishedPromise;
            clearInterval(poll);
            clearTimeout(timeout);
        } else {
            await finishedPromise;
        }
    } catch (error) {
        reason = reason === 'signal' ? reason : 'child-failure';
        try { fs.appendFileSync(controls.logPath, `${error.stack || error}\n`); } catch (_) { /* best effort */ }
    } finally {
        const serverTerminated = await stopChild(serverChild);
        if (logHandle !== undefined) fs.closeSync(logHandle);
        const portClosed = await waitUntil(() => portIsClosed(controls.port), 5000, 100);
        const pidRemoved = removeFile(controls.pidPath);
        const sentinelRemoved = removeFile(controls.sentinelPath);
        removeFile(serverPidMarker);
        const terminal = {
            schemaVersion: 1,
            reason: ['stop-requested', 'timeout', 'signal', 'child-failure'].includes(reason) ? reason : 'child-failure',
            serverTerminated,
            portClosed,
            pidRemoved,
            sentinelRemoved,
            verdict: serverTerminated && portClosed && pidRemoved && sentinelRemoved ? 'PASS' : 'FAIL'
        };
        ensureParent(controls.terminalPath);
        fs.writeFileSync(controls.terminalPath, `${JSON.stringify(terminal)}\n`);
        process.exitCode = terminal.verdict === 'PASS' ? 0 : 1;
    }
}

async function start(options) {
    const controls = lifecycleOptions(options, 'start');
    if (readPid(controls.pidPath)) throw new Error('an active guardian already owns the PID file');
    removeFile(controls.pidPath);
    removeFile(controls.sentinelPath);
    removeFile(controls.terminalPath);
    ensureParent(controls.logPath);
    ensureParent(controls.terminalPath);
    const child = spawn(process.execPath, [__filename, '--guardian', '--port', String(controls.port), '--pid', controls.pidPath, '--sentinel', controls.sentinelPath, '--log', controls.logPath, '--terminal', controls.terminalPath], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    const ready = await waitUntil(
        () => Boolean(readPid(controls.pidPath)) && portProbe(controls.port, '/discord-preview-payloads'),
        10000,
        100
    );
    const guardianPid = readPid(controls.pidPath);
    if (!ready || !guardianPid) {
        if (guardianPid) {
            fs.writeFileSync(controls.sentinelPath, 'stop\n');
            try { process.kill(guardianPid, 'SIGTERM'); } catch (_) { /* already gone */ }
        } else {
            try { process.kill(child.pid, 'SIGTERM'); } catch (_) { /* already gone */ }
        }
        throw new Error('guardian did not become ready');
    }
    const serverPid = await findServerPid(controls.logPath);
    if (!serverPid) {
        fs.writeFileSync(controls.sentinelPath, 'stop\n');
        try { process.kill(guardianPid, 'SIGTERM'); } catch (_) { /* already gone */ }
        throw new Error('server PID was not observable');
    }
    const result = {
        schemaVersion: 1,
        action: 'start',
        ready: true,
        guardianPid,
        serverPid,
        port: controls.port,
        payloadUrl: `http://127.0.0.1:${controls.port}/discord-preview-payloads`,
        pidPath: controls.pidPath,
        sentinelPath: controls.sentinelPath,
        logPath: controls.logPath,
        terminalPath: controls.terminalPath
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function findServerPid(logPath) {
    // The guardian records the child PID in a private marker, keeping the public log human-readable.
    const markerPath = `${logPath}.server-pid`;
    const found = await waitUntil(() => {
        try {
            const pid = Number(fs.readFileSync(markerPath, 'utf8').trim());
            return Number.isInteger(pid) && pid > 0;
        } catch (_) { return false; }
    }, 1000, 50);
    if (!found) return null;
    try { return Number(fs.readFileSync(markerPath, 'utf8').trim()); } catch (_) { return null; }
}

async function stop(options) {
    const controls = lifecycleOptions(options, 'stop');
    const guardianPid = readPid(controls.pidPath);
    if (!guardianPid) throw new Error('guardian PID is malformed, stale, or missing');
    ensureParent(controls.sentinelPath);
    fs.writeFileSync(controls.sentinelPath, 'stop\n');
    let escalated = false;
    let terminalReady = await waitUntil(() => fs.existsSync(controls.terminalPath), 5000, 100);
    if (!terminalReady) {
        escalated = true;
        try { process.kill(guardianPid, 'SIGTERM'); } catch (_) { /* already gone */ }
        terminalReady = await waitUntil(() => fs.existsSync(controls.terminalPath), 1000, 50);
    }
    if (!terminalReady) {
        escalated = true;
        try { process.kill(guardianPid, 'SIGKILL'); } catch (_) { /* already gone */ }
        terminalReady = await waitUntil(() => fs.existsSync(controls.terminalPath), 1000, 50);
    }
    const terminal = terminalReady ? JSON.parse(fs.readFileSync(controls.terminalPath, 'utf8')) : null;
    const portClosed = await waitUntil(() => portIsClosed(controls.port), 1000, 100);
    const pidRemoved = removeFile(controls.pidPath);
    const sentinelRemoved = removeFile(controls.sentinelPath);
    const pass = Boolean(terminal && terminal.verdict === 'PASS' && portClosed && pidRemoved && sentinelRemoved);
    const result = {
        schemaVersion: 1,
        action: 'stop',
        cleanup: pass,
        portClosed,
        pidRemoved,
        sentinelRemoved,
        escalated,
        guardianExitCode: pass ? 0 : 1,
        verdict: pass ? 'PASS' : 'FAIL'
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!pass) process.exitCode = 1;
}

async function selfTest() {
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'taa-discord-control-'));
    try {
        const malformed = path.join(directory, 'malformed.pid');
        fs.writeFileSync(malformed, 'not-a-pid\n');
        if (readPid(malformed) !== null) throw new Error('malformed PID accepted');
        const stale = path.join(directory, 'stale.pid');
        fs.writeFileSync(stale, '999999\n');
        if (readPid(stale) !== null) throw new Error('stale PID accepted');
        const active = path.join(directory, 'active.pid');
        fs.writeFileSync(active, `${process.pid}\n`);
        if (readPid(active) !== process.pid) throw new Error('active PID rejected');
        const startupPollFailure = !(await portProbe(65534, '/discord-preview-payloads'));
        const timeout = !(await waitUntil(() => false, 5, 1));
        const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setTimeout(()=>{},2000)"], { stdio: 'ignore' });
        const escalation = await stopChild(stubborn);
        if (!await portIsClosed(0) || !startupPollFailure || !timeout || !escalation) throw new Error('lifecycle self-test failed');
        process.stdout.write(`${JSON.stringify({ schemaVersion: 1, selfTest: true, malformedPid: true, stalePid: true, activePid: true, startupPollFailure, timeout, signal: true, escalation, verdict: 'PASS' })}\n`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function main(options) {
    if (options.selfTest) return selfTest();
    if (options.guardian) return guardian(options);
    if (options.action === 'start') return start(options);
    if (options.action === 'stop') return stop(options);
    throw new Error('action must be start or stop');
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
    main(parseArgs(process.argv.slice(2))).catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, readPid, portIsClosed, portProbe, waitUntil };
