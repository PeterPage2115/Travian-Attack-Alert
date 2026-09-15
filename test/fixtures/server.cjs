'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const fixtures = path.resolve(__dirname);
const port = Number(process.env.PORT || 8899);

function alliancePage(parsedUrl) {
    const state = parsedUrl.searchParams.get('panelState') || 'overview';
    const variant = parsedUrl.searchParams.get('memberTable') || '';
    const rows = variant === 'canonical'
        ? [900001, 900002, 900003].map((id, index) => `<tr><td class="player"><a href="/profile/${id}">Fixture Player ${String(index + 1).padStart(3, '0')}</a></td></tr>`).join('')
        : variant === 'rejected-pagination'
            ? '<tr><td class="player"><a href="/profile/900001">Fixture Player 900001</a></td></tr>'
            : '';
    const table = variant === 'canonical'
        ? `<table class="allianceMembers"><tbody>${rows}</tbody></table>`
        : variant === 'rejected-pagination'
            ? `<table class="allianceMembers" data-pagination="true"><tbody>${rows}</tbody></table>`
            : '';
    const canonicalize = state === 'standby' ? '' : '<script>history.replaceState(null,"","/alliance/profile/members");</script>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alliance loopback</title></head><body><main><h1>Alliance</h1>${table}<p id="panel-state-marker" data-panel-state="${state}" hidden>${state}</p></main><script>window.__TAA_TEST_ALLOW_PANEL__=true;window.__TAA_TEST_PANEL_STATE__=${JSON.stringify(state)};window.__TAA_GM_VALUES__=Object.create(null);window.GM_registerMenuCommand=()=>{};window.GM_getValue=(key,fallback)=>Object.prototype.hasOwnProperty.call(window.__TAA_GM_VALUES__,key)?window.__TAA_GM_VALUES__[key]:fallback;window.GM_setValue=(key,value)=>{window.__TAA_GM_VALUES__[key]=value};window.GM_deleteValue=(key)=>{delete window.__TAA_GM_VALUES__[key]};window.GM_xmlhttpRequest=(options)=>{if(new URL(options.url,location.href).origin!==location.origin)throw new Error('loopback-only');setTimeout(()=>options.onload?.({status:200,responseText:JSON.stringify({id:'fixture-message-id'})}),0)};</script>${canonicalize}<script src="/dist/travian-attack-alert.user.js"></script></body></html>`;
}

function contentType(filePath) {
    return filePath.endsWith('.txt')
        ? 'text/plain; charset=utf-8'
        : 'text/html; charset=utf-8';
}

if (process.env.TAA_FIXTURE_SERVER !== '1') {
    module.exports = {};
} else {
const server = http.createServer((request, response) => {
    const parsedUrl = new URL(
        String(request.url || '/'),
        `http://127.0.0.1:${port}`
    );
    const pathname = decodeURIComponent(parsedUrl.pathname);
    const fixtureName = parsedUrl.searchParams.get('fixture');
    if (pathname === '/alliance' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(alliancePage(parsedUrl));
        return;
    }
    const filePath = pathname === '/dist/travian-attack-alert.user.js'
        ? path.join(root, 'dist', 'travian-attack-alert.user.js')
        : pathname === '/alliance/profile' && fixtureName
            ? path.join(fixtures, fixtureName)
            : path.join(fixtures, pathname.replace(/^\/+/, ''));

    if (!filePath.startsWith(root) && !filePath.startsWith(fixtures)) {
        response.writeHead(404);
        response.end();
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            response.writeHead(404);
            response.end('not found');
            return;
        }

        response.writeHead(200, { 'Content-Type': contentType(filePath) });
        response.end(content);
    });
});

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`fixture-server:${port}\n`);
});

function shutdown() {
    server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
}
