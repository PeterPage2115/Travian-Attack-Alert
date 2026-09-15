'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const canonical = require('./canonical.cjs');

if (process.env.TAA_DISCORD_FIXTURE_SERVER !== '1') {
    module.exports = canonical;
} else {
const root = path.resolve(__dirname, '..', '..', '..');
const port = Number(process.env.PORT || 8898);
const requests = [];
const modeCounts = new Map();
const sockets = new Set();
const { previewCaseNames, previewCases, payloadsForCase } = canonical;

function jsonResponse(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
}

function sanitizeUrl(rawUrl) {
    const parsed = new URL(String(rawUrl || '/'), `http://127.0.0.1:${port}`);
    parsed.pathname = parsed.pathname.replace(
        /\/api\/webhooks\/\d+\/[^/]+/,
        '/api/webhooks/<id>/<redacted>'
    );
    return parsed.pathname + parsed.search;
}

function responseFor(mode) {
    if (mode === 'malformed') {
        return { status: 200, body: '<html>accepted</html>', type: 'text/html' };
    }

    if (mode === 'retryable') {
        const count = (modeCounts.get(mode) || 0) + 1;
        modeCounts.set(mode, count);
        if (count === 1) {
            return {
                status: 429,
                body: JSON.stringify({ retry_after: 1 }),
                type: 'application/json',
                headers: { 'Retry-After': '1' }
            };
        }
        return {
            status: 200,
            body: JSON.stringify({ id: 'm1' }),
            type: 'application/json'
        };
    }

    return {
        status: 200,
        body: JSON.stringify({ id: 'fixture-message-id' }),
        type: 'application/json'
    };
}

const server = http.createServer((request, response) => {
    const parsed = new URL(
        String(request.url || '/'),
        `http://127.0.0.1:${port}`
    );

    if (parsed.pathname === '/discord_stub' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ requests, requestCount: requests.length }));
        modeCounts.clear();
        return;
    }

    if (parsed.pathname === '/discord_stub' && request.method === 'POST') {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            requests.push({
                url: sanitizeUrl(request.url),
                bodyBytes: Buffer.concat(chunks).length
            });
            const result = responseFor(parsed.searchParams.get('mode') || 'valid');
            response.writeHead(result.status, Object.assign(
                { 'Content-Type': result.type },
                result.headers || {}
            ));
            response.end(result.body);
        });
        return;
    }

    if (parsed.pathname === '/discord-preview-payloads' && request.method === 'GET') {
        const caseName = parsed.searchParams.get('case');
        if (caseName !== null) {
            const payloads = payloadsForCase(caseName);
            if (!payloads) {
                jsonResponse(response, 404, { error: 'unknown-preview-case', caseName });
                return;
            }
            jsonResponse(response, 200, { schemaVersion: 1, caseName, payloads });
            return;
        }
        const cases = {};
        for (const name of previewCaseNames) cases[name] = { payloads: payloadsForCase(name) };
        jsonResponse(response, 200, { schemaVersion: 1, cases });
        return;
    }

    if (parsed.pathname === '/discord-preview' && request.method === 'GET') {
        const caseName = parsed.searchParams.get('case');
        if (!caseName || !previewCases[caseName]) {
            jsonResponse(response, 404, { error: 'unknown-preview-case', caseName });
            return;
        }
        const previewPath = path.join(__dirname, 'preview.html');
        fs.readFile(previewPath, (error, content) => {
            if (error) {
                response.writeHead(404);
                response.end('not found');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(content);
        });
        return;
    }

    const filePath = parsed.pathname === '/dist/travian-attack-alert.user.js'
        ? path.join(root, 'dist', 'travian-attack-alert.user.js')
        : parsed.pathname === '/alliance/profile'
            ? path.join(__dirname, 'profile.html')
            : null;

    if (!filePath || !filePath.startsWith(root)) {
        response.writeHead(404);
        response.end('not found');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            response.writeHead(404);
            response.end('not found');
            return;
        }
        response.writeHead(200, {
            'Content-Type': filePath.endsWith('.txt')
                ? 'text/plain; charset=utf-8'
                : 'text/html; charset=utf-8'
        });
        response.end(content);
    });
});

server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
});

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`discord-fixture:${port}\n`);
});

function shutdown() {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
}
