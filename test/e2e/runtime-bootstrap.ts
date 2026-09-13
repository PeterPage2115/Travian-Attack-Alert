import type { Page } from '@playwright/test';

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
  }
}

export type RuntimeScenario = {
  readonly path?: string;
  readonly leader?: boolean;
  readonly webhook?: boolean;
  readonly lateTable?: boolean;
  readonly continuousMutation?: boolean;
  // Todo 9 clean-install support: which artifact bytes to execute.
  // Defaults to '/script.txt' so every pre-existing spec is untouched.
  readonly artifactPath?: string;
};

export type ArtifactRuntime = {
  readonly reset: () => Promise<void>;
  readonly fixtureOrigin: string;
  readonly discordOrigin: string;
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
export async function installLoopbackTransport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = location.origin;
    const requests: string[] = window.__TAA_REQUESTS__ ?? [];
    window.__TAA_REQUESTS__ = requests;
    const chainedFetch = window.fetch.bind(window);
    window.GM_xmlhttpRequest = (options: { readonly method: string; readonly url: string; readonly data?: string; readonly onload?: (response: { readonly status: number; readonly responseText: string }) => void; readonly onerror?: (error: unknown) => void }) => {
      const target = options.url.includes('/api/webhooks/') ? `${fixture}/discord-webhook` : options.url;
      requests.push(target);
      chainedFetch(target, { method: options.method, body: options.data, headers: { 'Content-Type': 'application/json' } })
        .then(async (response) => options.onload?.({ status: response.status, responseText: await response.text() }))
        .catch((error) => options.onerror?.(error));
    };
  });
}

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/fake-fixture-token';

export async function installArtifactRuntime(page: Page, scenario: RuntimeScenario = {}): Promise<ArtifactRuntime> {
  const fixtureOrigin = new URL(page.url() || 'http://127.0.0.1:8899').origin;
  const discordOrigin = fixtureOrigin;
  await page.request.post('/e2e-log');
  await page.addInitScript(({ leader, webhook, fixture }) => {
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
      onSnapshot: (payload: Record<string, unknown>) => events.push({ kind: 'snapshot', status: payload.status, reason: payload.reason }),
    };
    window.GM_xmlhttpRequest = (options: { readonly method: string; readonly url: string; readonly data?: string; readonly onload?: (response: { readonly status: number; readonly responseText: string }) => void; readonly onerror?: (error: unknown) => void }) => {
      const target = options.url.includes('/api/webhooks/') ? `${fixture}/discord-webhook` : options.url;
      requests.push(target);
      originalFetch(target, { method: options.method, body: options.data, headers: { 'Content-Type': 'application/json' } })
        .then(async response => options.onload?.({ status: response.status, responseText: await response.text() }))
        .catch(error => options.onerror?.(error));
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void> | void) => {
        if (!leader) return undefined;
        return callback({ name: 'taa-monitor' });
      }
    } });
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), location.href);
      if (url.origin !== location.origin && url.origin !== fixture) throw new Error(`blocked fixture request: ${url.origin}`);
      if (url.pathname.startsWith('/profile/')) return Promise.resolve(new Response('<span>Fixture Player</span>', { status: 200 }));
      return originalFetch(input, init);
    };
    if (webhook) gm.travianAllianceWebhookUrl_v1 = 'https://discord.com/api/webhooks/123456789/fake-fixture-token';
    window.__TAA_E2E_SCENARIO__ = { leader, webhook, lateTable: false };
  }, { leader: scenario.leader !== false, webhook: scenario.webhook === true, fixture: fixtureOrigin });

  await page.goto(scenario.path || '/alliance/profile/members', { waitUntil: 'domcontentloaded' });
  if (scenario.lateTable || scenario.continuousMutation) {
    await page.evaluate(() => document.querySelector('table.allianceMembers')?.remove());
  }
  const artifact = await page.evaluate(async (artifactPath: string) => await (await fetch(artifactPath)).text(), scenario.artifactPath || '/script.txt');
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
    await page.evaluate(() => {
      window.setInterval(() => document.body.toggleAttribute('data-fixture-mutation'), 25);
    });
  }
  return {
    fixtureOrigin,
    discordOrigin,
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
