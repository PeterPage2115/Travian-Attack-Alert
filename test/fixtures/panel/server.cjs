'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = Number(process.env.PORT || 8899);
const PANEL_HTML = path.join(__dirname, 'attack-panel.html');

const sockets = new Set();
// Per-namespace fixture state. Playwright runs tests in parallel workers, and
// every worker's pages carry a distinct `?ns=<workerIndex>` on their loopback
// requests (see runtime-bootstrap.ts). Namespacing keeps each worker's
// discordRequests/webhookAttempts/deliveryHold isolated, so the exact-count
// assertions in clean-install/discord-delivery/dual-tab-lease/onboarding/
// migration specs cannot observe another worker's traffic. The default `''`
// namespace preserves the previous single-worker behavior.
const e2eStates = new Map();
function stateFor(ns) {
  let state = e2eStates.get(ns);
  if (!state) {
    state = { discordRequests: [], openRequests: 0, webhookAttempts: 0, deliveryHold: false };
    e2eStates.set(ns, state);
  }
  return state;
}

// Playwright's page.request APIRequestContext reuses idle keep-alive sockets.
// Node's default keepAliveTimeout (5 s) closes them while a spec does other
// work (observed as ECONNRESET on the warm-up POST, CI run 35931796105), so
// keep loopback sockets alive for the whole run. headersTimeout must stay
// above keepAliveTimeout (Node's documented pairing).
const KEEP_ALIVE_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 125_000;

function configureKeepAlive(target) {
  target.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  target.headersTimeout = HEADERS_TIMEOUT_MS;
}

function sendFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  });
}

function memberTableMarkup(variant) {
  if (variant === 'canonical') {
    const rows = [900001, 900002, 900003]
      .map((id, index) => `<tr><td class="player"><a href="/profile/${id}">Fixture Player ${String(index + 1).padStart(3, '0')}</a></td></tr>`)
      .join('');
    return `<table class="allianceMembers"><tbody>${rows}</tbody></table>`;
  }
  if (variant === 'rejected-pagination') {
    return `<table class="allianceMembers" data-pagination="true"><tbody><tr><td class="player"><a href="/profile/900001">Fixture Player 001</a></td></tr></tbody></table>`;
  }
  if (variant === 'late') return '<table class="allianceMembers"><tbody><tr><td class="player"><a href="/profile/900001">Fixture Player 001</a></td></tr></tbody></table>';
  return null;
}

function handleAlliance(request, response) {
  const url = new URL(String(request.url || '/'), `http://127.0.0.1:${PORT}`);
  const panelState = url.searchParams.get('panelState') || 'overview';
  const memberTable = url.searchParams.get('memberTable') || 'absent';
  fs.readFile(PANEL_HTML, 'utf8', (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('missing panel fixture');
      return;
    }
    let withState = content.replace('<script src="/dist/travian-attack-alert.user.js"></script>', '').replace(
      'window.__TAA_TEST_ALLOW_PANEL__ = true;',
      `window.__TAA_TEST_ALLOW_PANEL__ = true; window.__TAA_TEST_PANEL_STATE__ = ${JSON.stringify(panelState)};`
    );
    const markup = memberTableMarkup(memberTable);
    withState = withState.replace(
      /<table aria-label="Alliance members">[\s\S]*?<\/table>/,
      markup || ''
    );
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(withState);
  });
}

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
  const canonicalize = '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alliance loopback</title></head><body><main><h1>Alliance</h1>${table}<p id="panel-state-marker" data-panel-state="${state}" hidden>${state}</p></main><script>window.__TAA_TEST_ALLOW_PANEL__=true;window.__TAA_TEST_PANEL_STATE__=${JSON.stringify(state)};window.__TAA_GM_VALUES__=Object.create(null);window.GM_registerMenuCommand=()=>{};window.GM_getValue=(key,fallback)=>Object.prototype.hasOwnProperty.call(window.__TAA_GM_VALUES__,key)?window.__TAA_GM_VALUES__[key]:fallback;window.GM_setValue=(key,value)=>{window.__TAA_GM_VALUES__[key]=value};window.GM_deleteValue=(key)=>{delete window.__TAA_GM_VALUES__[key]};window.GM_xmlhttpRequest=(options)=>{if(new URL(options.url,location.href).origin!==location.origin)throw new Error('loopback-only');setTimeout(()=>options.onload?.({status:200,responseText:JSON.stringify({id:'fixture-message-id'})}),0)};</script>${canonicalize}<script src="/dist/travian-attack-alert.user.js"></script></body></html>`;
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function handleMemberRoute(request, response) {
  const parsed = new URL(String(request.url || '/'), `http://127.0.0.1:${PORT}`);
  const table = parsed.pathname.endsWith('/extra') ? 'absent' : parsed.searchParams.get('memberTable') || 'canonical';
  handleAlliance(Object.assign(request, { url: `/alliance?memberTable=${encodeURIComponent(table)}&panelState=overview` }), response);
}

// HTTP harness GET /alliance?panelState=... on PORT=8899 with __TAA_TEST_ALLOW_PANEL__ bypass
function handleRequest(request, response) {
  const rawUrl = String(request.url || '/');
  const parsed = new URL(rawUrl, `http://127.0.0.1:${PORT}`);
  const pathname = parsed.pathname;

  if (pathname === '/alliance' || pathname === '/alliance/') {
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end('method not allowed');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(alliancePage(parsed));
    return;
  }

  if (pathname === '/alliance/profile/members' || pathname === '/alliance/profile/members/extra') {
    if (request.method !== 'GET') { response.writeHead(405); response.end('method not allowed'); return; }
    handleMemberRoute(request, response);
    return;
  }

  if (pathname === '/fixtures/member-table' || pathname.startsWith('/fixtures/member-table/')) {
    const variant = pathname.split('/').pop() || 'canonical';
    const markup = memberTableMarkup(variant) || '<table class="allianceMembers"><tbody></tbody></table>';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(markup);
    return;
  }

  // Fixture servers serve the generated dist installable so e2e executes the
  // exact release artifact.
  if (pathname === '/dist/travian-attack-alert.user.js') {
    sendFile(response, path.join(ROOT, 'dist', 'travian-attack-alert.user.js'), 'text/plain; charset=utf-8');
    return;
  }

  if (pathname === '/discord-webhook' && request.method === 'POST') {
    const startedAt = Date.now();
    const chunks = [];
    const e2eState = stateFor(parsed.searchParams.get('ns') || '');
    e2eState.openRequests += 1;
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      e2eState.webhookAttempts += 1;
      e2eState.discordRequests.push({ attempt: e2eState.webhookAttempts, startedAt, endedAt: Date.now(), body: JSON.parse(body || '{}') });
      e2eState.openRequests -= 1;
      const respond = () => {
        if (e2eState.webhookAttempts === 1) {
          response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          response.end(JSON.stringify({ retry_after: 1 }));
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ id: 'fixture-message-id' }));
        }
      };
      // Todo 11 fence-loss arm: while deliveryHold is true the response is
      // withheld (the request is already logged above), so a test can revoke
      // the page's lease mid-flight and prove the settle path stays
      // recoverable. Defaults to false: every pre-existing spec is untouched.
      if (e2eState.deliveryHold) {
        const timer = setInterval(() => {
          if (!e2eState.deliveryHold) {
            clearInterval(timer);
            respond();
          }
        }, 25);
      } else {
        respond();
      }
    });
    return;
  }

  if (pathname === '/e2e-delivery-hold') {
    const e2eState = stateFor(parsed.searchParams.get('ns') || '');
    if (request.method === 'POST') {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          e2eState.deliveryHold = parsed.hold === true;
        } catch {
          e2eState.deliveryHold = false;
        }
        sendJson(response, 200, { hold: e2eState.deliveryHold });
      });
      return;
    }
    sendJson(response, 200, { hold: e2eState.deliveryHold });
    return;
  }

  if (pathname === '/e2e-log') {
    const e2eState = stateFor(parsed.searchParams.get('ns') || '');
    if (request.method === 'POST') {
      e2eState.discordRequests.length = 0;
      e2eState.webhookAttempts = 0;
      e2eState.deliveryHold = false;
      sendJson(response, 200, { reset: true, openRequests: e2eState.openRequests });
    } else sendJson(response, 200, { ...e2eState, discordRequests: [...e2eState.discordRequests] });
    return;
  }

  if (pathname === '/health' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, panelState: parsed.searchParams.get('panelState') || null }));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('not found');
}

const server = http.createServer(handleRequest);
configureKeepAlive(server);

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`panel-fixture:${PORT}\n`);
});

// Todo 9 clean-install harness support: the product's Discord payload builder
// (safeAllianceUrl) only trusts https page origins, so artifact dispatch cannot
// be proven over the plain-http fixture. Serve the SAME handler over TLS on
// 127.0.0.1:8898 with an ephemeral self-signed loopback cert generated at
// startup into os.tmpdir (never committed, never reused across runs). If cert
// generation fails, https stays unavailable and http behavior is unchanged.
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8898);
let httpsServer = null;
try {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-https-'));
  const keyPath = path.join(tmp, 'key.pem');
  const certPath = path.join(tmp, 'cert.pem');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8' });
  if (generated.status === 0 && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    httpsServer = require('node:https').createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      handleRequest,
    );
    configureKeepAlive(httpsServer);
    httpsServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    httpsServer.listen(HTTPS_PORT, '127.0.0.1', () => {
      process.stdout.write(`panel-fixture-https:${HTTPS_PORT}\n`);
    });
  } else {
    process.stderr.write('panel-fixture: https disabled (openssl cert generation failed)\n');
  }
} catch (error) {
  process.stderr.write(`panel-fixture: https disabled (${error && error.message ? error.message : error})\n`);
}

function shutdown() {
  for (const socket of sockets) socket.destroy();
  server.close(() => {
    if (httpsServer) httpsServer.close(() => process.exit(0));
    else process.exit(0);
  });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

module.exports = { server, PORT };
