import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Worker-safe evidence writer. Parallel workers all append phases to the SAME
// per-spec evidence file, so a naive read-modify-write loses updates. Each
// worker writes its own fragment under os.tmpdir() (never inside test-results/,
// which CI seals and scans for an exact file count) and the final merged file
// is rebuilt from all fragments; the merge is idempotent, last-writer-wins.
export function writeEvidencePhase(
  evidencePath: string,
  phase: string,
  value: Record<string, unknown>,
  workerIndex: number,
  redact: (input: unknown) => unknown = (input) => input,
): void {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const fragmentDir = path.join(os.tmpdir(), 'taa-e2e-evidence-fragments');
  fs.mkdirSync(fragmentDir, { recursive: true });
  const fragmentKey = `${path.resolve(evidencePath).replace(/[^a-zA-Z0-9]+/gu, '_')}.worker-${workerIndex}.json`;
  const fragmentPath = path.join(fragmentDir, fragmentKey);
  const fragment = fs.existsSync(fragmentPath) ? JSON.parse(fs.readFileSync(fragmentPath, 'utf8')) : {};
  fragment[phase] = value;
  fs.writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);

  const merged: Record<string, unknown> = {};
  const prefix = fragmentKey.replace(/\.worker-\d+\.json$/u, '.worker-');
  for (const entry of fs.readdirSync(fragmentDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(path.join(fragmentDir, entry), 'utf8')));
    } catch {
      // A fragment being written concurrently is retried on the next phase.
    }
  }
  fs.writeFileSync(evidencePath, `${JSON.stringify(redact(merged), null, 2)}\n`);
}

declare global {
  interface Window {
    GM_getValue: (key: string, fallback?: unknown) => unknown;
    GM_setValue: (key: string, value: unknown) => void;
    GM_deleteValue: (key: string) => void;
    GM_registerMenuCommand: (name: string, callback: () => void) => void;
    GM_xmlhttpRequest: (options: { readonly method: string; readonly url: string; readonly data?: string; readonly onload?: (response: { readonly status: number; readonly responseText: string }) => void; readonly onerror?: (error: unknown) => void }) => void;
    __TAA_MENU__?: Record<string, () => void>;
    __TAA_REQUESTS__?: string[];
    __TAA_GM_VALUES__?: Record<string, unknown>;
    __TAA_E2E_SCENARIO__?: RuntimeScenario;
    __TAA_E2E_EVENTS__?: Array<Record<string, unknown>>;
    __TAA_TEST_HOOK__?: Record<string, (payload: Record<string, unknown>) => void>;
    // Readiness probe contract: readystatechange values since document start,
    // DOM mutation records delivered since document start, when the artifact
    // armed its sole one-shot DOMContentLoaded readiness listener, and when the
    // task-3 hydration timer appended member rows (`hydratedAt`, page clock).
    // Installed for every scenario, not only holdInteractive, so unrelated-DOM
    // churn evidence carries the same mutation/readyState counters.
    __TAA_READY_PROBE__?: { readyStates: string[]; mutations: number; readinessListenerAt: number | null; hydratedAt: number | null };
  }
}

export type RuntimeScenario = {
  readonly path?: string;
  readonly leader?: boolean;
  readonly webhook?: boolean;
  readonly lateTable?: boolean;
  readonly continuousMutation?: boolean;
  // Todo 9 clean-install support: which artifact bytes to execute.
  // Defaults to the generated dist installable so every spec runs the exact
  // release artifact.
  readonly artifactPath?: string;
  // Todo 11 dual-tab lease proof: when true, the navigator.locks stub is NOT
  // installed, so the page uses REAL Web Locks. Two pages in ONE browser
  // context then genuinely contend for the exclusive lock (shared origin +
  // shared localStorage, like two real tabs). Defaults to false, so every
  // pre-existing spec keeps its deterministic leader/standby stub.
  readonly realLocks?: boolean;
  // Per-worker fixture-state namespace (parallel runs). Defaults to '' which
  // is the single-worker behavior; specs pass testInfo.workerIndex so each
  // worker's loopback traffic is counted in isolation.
  readonly ns?: string | number;
  // Hold the document at `interactive` behind a delayed loopback image whose
  // response the fixture server parks until the spec releases it. The artifact
  // is then executed with a global eval instead of a <script> insert, so the
  // only DOM activity is the artifact's own startup; the release to `complete`
  // is driven by a subresource load, never by a mutation.
  readonly holdInteractive?: boolean;
  // Task-3 member-table variant. Travels in the `x-taa-member-table` request
  // header (never a query param: a query flips the route to
  // `alliance-noncanonical`). `members59` is the 59-row authoritative fixture
  // roster, `partial-12` is its first 12 rows, `empty-shell` is an accepted
  // table with zero rows and `absent` renders no table at all.
  readonly memberTable?: 'canonical' | 'absent' | 'members59' | 'partial-12' | 'empty-shell';
  // Unrelated DOM churn: toggle a NON-table body attribute every 25ms BEFORE
  // the artifact boots. The member table itself is never touched, so a fixed
  // runtime must ignore this activity instead of starving the quiet window.
  readonly bodyChurn?: boolean;
  // Append the remaining `members59` fixture rows `hydrateMemberTableAfterMs`
  // after the artifact boots (inside the page). With an `empty-shell` page this
  // hydrates an empty table; with `partial-12` it completes the partial roster.
  // `hydrateKeepRows` selects which fixture rows are appended (defaults to all).
  readonly hydrateMemberTableAfterMs?: number;
  readonly hydrateKeepRows?: number;
  // Restore persisted GM values (e.g. a monitor envelope captured from an
  // earlier accepted scan) into the fresh per-document GM store BEFORE the
  // artifact boots. Mirrors clean-install.spec.ts's snapshot/restore technique,
  // which the harness cannot do itself because its GM store dies with the
  // document.
  readonly seedGMValues?: Record<string, string>;
};

export type ArtifactRuntime = {
  readonly reset: () => Promise<void>;
  readonly fixtureOrigin: string;
  readonly discordOrigin: string;
  readonly holdPending: () => Promise<boolean>;
  readonly releaseHeldLoad: () => Promise<void>;
  readonly readProbe: () => Promise<{
    readonly readyStates: string[];
    readonly mutations: number;
    readonly readyState: string;
    readonly readinessListenerAt: number | null;
    readonly hydratedAt: number | null;
  }>;
};

/**
 * Todo 9 clean-install support (opt-in; every pre-existing spec is untouched).
 *
 * The panel fixture page (attack-panel.html) installs its own inline
 * GM_xmlhttpRequest stub that fake-acknowledges (200 + fixture id) WITHOUT
 * touching the network — page scripts run after addInitScript, so the inline
 * stub wins over the loopback-rewriting stub above. Specs that must observe
 * REAL artifact dispatch on the loopback /discord-webhook sink call this
 * AFTER each navigation (it re-installs the loopback transport over whatever
 * the page installed). GM value stores are left alone.
 */
export async function installLoopbackTransport(page: Page, ns: string | number = ''): Promise<void> {
  const nsQuery = ns === '' ? '' : `?ns=${encodeURIComponent(String(ns))}`;
  await page.evaluate((nsQuery: string) => {
    const fixture = location.origin;
    const requests: string[] = window.__TAA_REQUESTS__ ?? [];
    window.__TAA_REQUESTS__ = requests;
    const chainedFetch = window.fetch.bind(window);
    window.GM_xmlhttpRequest = (options: { readonly method: string; readonly url: string; readonly data?: string; readonly onload?: (response: { readonly status: number; readonly responseText: string }) => void; readonly onerror?: (error: unknown) => void }) => {
      const target = options.url.includes('/api/webhooks/') ? `${fixture}/discord-webhook${nsQuery}` : options.url;
      requests.push(target);
      chainedFetch(target, { method: options.method, body: options.data, headers: { 'Content-Type': 'application/json' } })
        .then(async (response) => options.onload?.({ status: response.status, responseText: await response.text() }))
        .catch((error) => options.onerror?.(error));
    };
  }, nsQuery);
}

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/fake-fixture-token';

/**
 * Fixture-transport warm-up for the loopback /discord-webhook sink: burns the
 * sink's first-attempt 429 so a measured window shows product traffic only.
 *
 * Playwright's page.request APIRequestContext reuses idle keep-alive sockets,
 * and a socket the fixture closed between calls surfaces as a thrown
 * ECONNRESET before the server ever sees the POST (CI run 35931796105). The
 * retry is gated on the server log: the fixture records a request on `end`
 * before it answers, so a non-zero count means the attempt already landed and
 * MUST NOT be repeated. Only a request the fixture never logged is retried,
 * after a short delay, until a bounded deadline; otherwise the error rethrows.
 * The final poll keeps the original contract: exactly ONE warm-up entry.
 */
const WARMUP_RETRY_DEADLINE_MS = 10_000;
const WARMUP_RETRY_DELAY_MS = 250;

export async function warmupLoopbackTransport(
  page: Page,
  serverRequestCount: (page: Page) => Promise<number>,
  ns: string | number = '',
): Promise<void> {
  const nsQuery = ns === '' ? '' : `?ns=${encodeURIComponent(String(ns))}`;
  const deadline = Date.now() + WARMUP_RETRY_DEADLINE_MS;
  for (;;) {
    try {
      await page.request.post(`/discord-webhook${nsQuery}`, {
        data: { content: 'warmup', allowed_mentions: { users: [] } },
        headers: { 'Content-Type': 'application/json' },
      });
      break;
    } catch (error) {
      if ((await serverRequestCount(page)) > 0) break; // already logged: never post twice
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, WARMUP_RETRY_DELAY_MS));
    }
  }
  await expect.poll(() => serverRequestCount(page), { timeout: 5_000 }).toBe(1);
}

export async function installArtifactRuntime(page: Page, scenario: RuntimeScenario = {}): Promise<ArtifactRuntime> {
  const fixtureOrigin = new URL(page.url() || 'http://127.0.0.1:8899').origin;
  const discordOrigin = fixtureOrigin;
  // Parallel workers share one fixture server, so every loopback request this
  // page makes carries a per-worker namespace. The server keeps a separate
  // e2eState per namespace, which is what makes the exact discordRequests
  // counts in the delivery specs immune to another worker's traffic.
  const ns = String(scenario.ns ?? '');
  const nsQuery = ns ? `?ns=${encodeURIComponent(ns)}` : '';
  const holdPending = async (): Promise<boolean> => {
    const response = await page.request.get(`/e2e-hold-status${nsQuery}`);
    return (await response.json() as { readonly pending?: boolean }).pending === true;
  };
  const releaseHeldLoad = async (): Promise<void> => {
    await expect.poll(async () => {
      const response = await page.request.post(`/e2e-release-load${nsQuery}`);
      return (await response.json() as { readonly released?: boolean }).released === true;
    }, { timeout: 5_000 }).toBe(true);
  };
  const readProbe = async (): Promise<{
    readonly readyStates: string[];
    readonly mutations: number;
    readonly readyState: string;
    readonly readinessListenerAt: number | null;
    readonly hydratedAt: number | null;
  }> => await page.evaluate(() => {
    const probe = window.__TAA_READY_PROBE__ ?? { readyStates: [], mutations: 0, readinessListenerAt: null, hydratedAt: null };
    return {
      readyStates: [...probe.readyStates],
      mutations: probe.mutations,
      readyState: document.readyState,
      readinessListenerAt: probe.readinessListenerAt,
      hydratedAt: probe.hydratedAt,
    };
  });
  await page.request.post(`/e2e-log${nsQuery}`);
  await page.addInitScript(({ leader, webhook, fixture, realLocks, nsQuery }) => {
    const gm = Object.create(null) as Record<string, unknown>;
    const requests: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const start = performance.now();
    const originalFetch = window.fetch.bind(window);
    const RealDate = Date;
    const fixedEpoch = 1_788_480_000_000;
    class DeterministicDate extends RealDate {
      static now(): number { return fixedEpoch + Math.floor(performance.now() - start); }
    }
    Object.defineProperty(window, 'Date', { configurable: true, value: DeterministicDate });
    window.GM_getValue = (key: string, fallback?: unknown) => Object.hasOwn(gm, key) ? gm[key] : fallback;
    window.GM_setValue = (key: string, value: unknown) => { gm[key] = value; };
    window.GM_deleteValue = (key: string) => { delete gm[key]; };
    window.__TAA_GM_VALUES__ = gm;
    window.GM_registerMenuCommand = (name: string, callback: () => void) => { (window.__TAA_MENU__ ||= {})[name] = callback; };
    window.__TAA_REQUESTS__ = requests;
    window.__TAA_E2E_EVENTS__ = events;
    window.__TAA_TEST_HOOK__ = {
      onReadinessCommit: (payload: Record<string, unknown>) => events.push({ kind: 'readiness', atMs: payload.atMs, quietMs: payload.quietMs }),
      onExtractionStart: (payload: Record<string, unknown>) => events.push({ kind: 'extraction', observedAtMs: payload.observedAtMs }),
      // `atMs` is the snapshot's observation time on the page's (deterministic)
      // clock; task-3 uses it to prove no extraction happened before the
      // member table was hydrated.
      onSnapshot: (payload: Record<string, unknown>) => events.push({ kind: 'snapshot', status: payload.status, reason: payload.reason, atMs: payload.observedAtMs }),
    };
    window.GM_xmlhttpRequest = (options: { readonly method: string; readonly url: string; readonly data?: string; readonly onload?: (response: { readonly status: number; readonly responseText: string }) => void; readonly onerror?: (error: unknown) => void }) => {
      const target = options.url.includes('/api/webhooks/') ? `${fixture}/discord-webhook${nsQuery}` : options.url;
      requests.push(target);
      originalFetch(target, { method: options.method, body: options.data, headers: { 'Content-Type': 'application/json' } })
        .then(async response => options.onload?.({ status: response.status, responseText: await response.text() }))
        .catch(error => options.onerror?.(error));
    };
    // Todo 11: realLocks skips this stub so the page contends on REAL Web
    // Locks. Without the skip, leader:true would grant the lock to EVERY page
    // and prove nothing about exclusivity.
    if (!realLocks) {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void> | void) => {
        if (!leader) return undefined;
        return callback({ name: 'taa-monitor' });
      }
    } });
    }
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), location.href);
      if (url.origin !== location.origin && url.origin !== fixture) throw new Error(`blocked fixture request: ${url.origin}`);
      if (url.pathname.startsWith('/profile/')) return Promise.resolve(new Response('<span>Fixture Player</span>', { status: 200 }));
      return originalFetch(input, init);
    };
    if (webhook) gm.travianAllianceWebhookUrl_v1 = 'https://discord.com/api/webhooks/123456789/fake-fixture-token';
    window.__TAA_E2E_SCENARIO__ = { leader, webhook, lateTable: false };
  }, { leader: scenario.leader !== false, webhook: scenario.webhook === true, fixture: fixtureOrigin, realLocks: scenario.realLocks === true, nsQuery });

  // Probe installed for EVERY scenario (not only holdInteractive): readiness
  // listener arming, readyState transitions and DOM mutation counts are the
  // task-3 evidence, and the probe itself is behavior-neutral.
  await page.addInitScript(() => {
    const probe: { readyStates: string[]; mutations: number; readinessListenerAt: number | null; hydratedAt: number | null } = {
      readyStates: [],
      mutations: 0,
      readinessListenerAt: null,
      hydratedAt: null,
    };
    window.__TAA_READY_PROBE__ = probe;
    document.addEventListener('readystatechange', () => { probe.readyStates.push(document.readyState); });
    const counter = new MutationObserver((records) => { probe.mutations += records.length; });
    counter.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this === document && type === 'DOMContentLoaded' && options && (options as AddEventListenerOptions).once === true && probe.readinessListenerAt === null) {
        probe.readinessListenerAt = Date.now();
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };
  });

  const headers: Record<string, string> = {};
  if (scenario.holdInteractive) {
    headers['x-taa-hold-load'] = '1';
    if (ns) headers['x-taa-hold-ns'] = ns;
  }
  if (scenario.memberTable) headers['x-taa-member-table'] = scenario.memberTable;
  await page.setExtraHTTPHeaders(headers);

  const applySeedGM = async (): Promise<void> => {
    if (!scenario.seedGMValues) return;
    await page.evaluate((values: Record<string, string>) => {
      const gm = window.__TAA_GM_VALUES__ ?? (window.__TAA_GM_VALUES__ = Object.create(null) as Record<string, unknown>);
      for (const [key, value] of Object.entries(values)) gm[key] = value;
    }, scenario.seedGMValues);
  };

  const scheduleHydration = async (): Promise<void> => {
    const delayMs = scenario.hydrateMemberTableAfterMs;
    if (!delayMs) return;
    const keepRows = scenario.hydrateKeepRows ?? 0;
    await page.evaluate(async ({ delay, keep }: { delay: number; keep: number }) => {
      const html = await (await fetch('/fixtures/member-table/members59')).text();
      const template = document.createElement('template');
      template.innerHTML = html;
      const sourceTable = template.content.querySelector('table.allianceMembers');
      if (!sourceTable) throw new Error('members59 fixture table missing');
      const sourceRows = Array.from(sourceTable.querySelectorAll('tbody tr'));
      window.setTimeout(() => {
        const probe = window.__TAA_READY_PROBE__;
        if (probe) probe.hydratedAt = Date.now();
        const existing = document.querySelector('table.allianceMembers');
        if (!existing) {
          document.body.append(sourceTable);
          return;
        }
        const tbody = existing.querySelector('tbody');
        if (!tbody) throw new Error('member table tbody missing');
        for (const row of sourceRows.slice(keep)) tbody.append(row.cloneNode(true));
      }, delay);
    }, { delay: delayMs, keep: keepRows });
  };

  const artifactPath = scenario.artifactPath || '/dist/travian-attack-alert.user.js';
  if (scenario.holdInteractive) {
    await page.goto(scenario.path || '/alliance/profile/members', { waitUntil: 'domcontentloaded' });
    await expect.poll(holdPending, { timeout: 5_000 }).toBe(true);
    await applySeedGM();
    // Global indirect eval instead of page.addScriptTag: the script-element
    // insert is itself a DOM mutation record, and this scenario must reach
    // `complete` with none after the readiness observer is armed.
    const artifact = await page.evaluate(async (path2: string) => await (await fetch(path2)).text(), artifactPath);
    await page.evaluate((source: string) => { (0, eval)(source); }, artifact);
    await expect.poll(async () => await page.evaluate(() => window.__TAA_READY_PROBE__?.readinessListenerAt ?? null), { timeout: 10_000 }).not.toBeNull();
    await scheduleHydration();
  } else {
    await page.goto(scenario.path || '/alliance/profile/members', { waitUntil: 'domcontentloaded' });
    if (scenario.bodyChurn) {
      await page.evaluate(() => {
        window.setInterval(() => document.body.toggleAttribute('data-fixture-mutation'), 25);
      });
    }
    if (scenario.lateTable || scenario.continuousMutation) {
      await page.evaluate(() => document.querySelector('table.allianceMembers')?.remove());
    }
    await applySeedGM();
    const artifact = await page.evaluate(async (path2: string) => await (await fetch(path2)).text(), artifactPath);
    await page.addScriptTag({ content: artifact });
    if (scenario.lateTable) {
      await page.evaluate(() => {
        window.setTimeout(() => {
          const table = document.createElement('table');
          table.className = 'allianceMembers';
          table.innerHTML = '<tbody><tr><td class="player"><a href="/profile/900001">Fixture Player 001</a></td></tr></tbody>';
          document.body.append(table);
        }, 100);
      });
    }
    if (scenario.continuousMutation) {
      // Task-3 retarget: the storm now lands on MEMBER-TABLE rows (the table is
      // re-added first), so this scenario guards "table churn must still fail
      // closed" after the readiness fix. Non-table body churn moved to
      // `bodyChurn`, which a fixed runtime must ignore.
      await page.evaluate(() => {
        window.setTimeout(() => {
          if (document.querySelector('table.allianceMembers')) return;
          const table = document.createElement('table');
          table.className = 'allianceMembers';
          table.innerHTML = '<tbody><tr><td class="player"><a href="/profile/900001">Fixture Player 001</a></td></tr></tbody>';
          document.body.append(table);
        }, 300);
        window.setInterval(() => {
          const tbody = document.querySelector('table.allianceMembers tbody');
          if (!tbody) return;
          const storm = tbody.querySelector('tr[data-fixture-storm]');
          if (storm) {
            storm.remove();
            return;
          }
          const row = document.createElement('tr');
          row.setAttribute('data-fixture-storm', '1');
          row.innerHTML = '<td class="player"><a href="/profile/900099">Fixture Storm</a></td>';
          tbody.append(row);
        }, 25);
      });
    }
    await scheduleHydration();
  }
  return {
    fixtureOrigin,
    discordOrigin,
    holdPending,
    releaseHeldLoad,
    readProbe,
    reset: async () => page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      const gm = window.__TAA_GM_VALUES__;
      if (gm) for (const key of Object.keys(gm)) delete gm[key];
       if (window.__TAA_REQUESTS__) window.__TAA_REQUESTS__.length = 0;
       if (window.__TAA_E2E_EVENTS__) window.__TAA_E2E_EVENTS__.length = 0;
    })
  };
}

export { WEBHOOK };
