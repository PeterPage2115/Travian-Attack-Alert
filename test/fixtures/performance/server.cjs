'use strict';

/* Generated 60-player browser fixture. It is intentionally a module so the
 * Playwright driver can choose its port without adding a test dependency. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function playerRows() {
    return Array.from({ length: 60 }, (_, index) => {
        const id = index + 1;
        const attacks = id % 4;
        const raids = id % 5 === 0 ? 1 : 0;
        const tooltip = raids > 0
            ? `${attacks} attacks, ${raids} raid`
            : `${attacks} attacks`;
        return `<tr><td><a href="/profile/${id}">Player ${id}</a></td>` +
            `<td><img class="attack" alt="${tooltip}" title="${tooltip}"></td></tr>`;
    }).join('');
}

function pageHtml() {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Performance fixture</title></head>' +
        `<body><main><h1>Alliance members</h1><table class="allianceMembers"><tbody>${playerRows()}</tbody></table></main></body></html>`;
}

function createServer(rootDir = path.resolve(__dirname, '../..', '..')) {
    return http.createServer((request, response) => {
        if (request.url === '/script.txt') {
            response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(fs.readFileSync(path.join(rootDir, 'script.txt')));
            return;
        }
        if (request.url && request.url.startsWith('/alliance/profile')) {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(pageHtml());
            return;
        }
        response.writeHead(404);
        response.end('not found');
    });
}

if (process.env.TAA_PERFORMANCE_FIXTURE_SERVER === '1') {
    const server = createServer();
    server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
        process.stdout.write(String(server.address().port) + '\n');
    });
}

module.exports = { createServer, pageHtml, playerRows };
