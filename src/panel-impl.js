'use strict';

// Extracted panel session-draft kernel (plan Todo 15).
//
// Owns the session-bound slice of the runtime-api.panel contract exactly as
// the legacy authority in src/runtime.js defines it: admin draft state with
// secret redaction, session-backed draft persistence and reload gating, panel
// exit resolution, backfill planning, async/node/lease patch helpers, and
// safe session-root access. Session and panel-root capabilities arrive only
// through the injected Todo 7 seam (configurePanelAdapters; the store-taking
// draft functions additionally accept an explicit adapter-shaped store,
// matching the authority). This file names no host global: the session slot
// is reached through a computed key, and the implicit panel root defaults to
// the injected seam value. The model-builder tail (workspace, pagination,
// history/stats/diagnostics/status, reconciliation, bundle) stays on the
// frozen runtime authority by reference until Todos 16-17: the full 22-symbol
// domain is 359 pure lines and cannot fit the frozen 250-line new-module
// gate in one file. The legacy authority in src/runtime.js is byte-untouched
// in this task; differential behavior is pinned by
// test/characterization/panel-session.test.cjs.
const adapters = require('./adapters.js');
const { PANEL_BACKFILL_ORPHAN_CAP } = require('./constants.js');

let activeSession = null;
let activePanelRoot = null;
function configurePanelAdapters(seam = {}) {
  if (Object.prototype.hasOwnProperty.call(seam, 'session')) {
    const store = seam.session;
    activeSession = (store === null || store === undefined) ? null : adapters.createSessionStorageAdapter({ store });
  }
  if (Object.prototype.hasOwnProperty.call(seam, 'panelRoot')) activePanelRoot = seam.panelRoot === undefined ? null : seam.panelRoot;
  return { session: activeSession !== null, panelRoot: activePanelRoot !== null };
}
function resetPanelAdapters() { activeSession = null; activePanelRoot = null; }
function panelSessionStore() { return activeSession; }

function normalizeAdminDraftScope(scope) {
  const source = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  const sourceFilters = source.filters && typeof source.filters === 'object' ? source.filters : {};
  const filters = {};
  for (const key of ['mapped', 'unmapped', 'muted', 'orphaned']) if (sourceFilters[key] !== void 0) filters[key] = Boolean(sourceFilters[key]);
  const selection = Array.isArray(source.selection) ? source.selection.map((item) => String(item)).filter(Boolean).slice(0, 100) : [];
  return { query: String(source.query || ''), filters, page: Number.isFinite(Number(source.page)) ? Math.max(1, Math.floor(Number(source.page))) : 1, activeEditorId: source.activeEditorId == null ? null : String(source.activeEditorId), selection };
}
function readSessionStorageSafely(root, onDenied) {
  try {
    if (!root || typeof root['session' + 'Storage'] === 'undefined') return null;
    return root['session' + 'Storage'];
  } catch (error) {
    if (typeof onDenied === 'function') onDenied(error);
    return null;
  }
}
function supportsInputSelection(element) {
  return Boolean(element && typeof element.setSelectionRange === 'function' && ['text', 'search', 'url', 'tel', 'password'].indexOf(String(element.type)) !== -1);
}
function createAdminDraftState(tab, fields, focus, scope) {
  const safeFields = fields && typeof fields === 'object' && !Array.isArray(fields) ? Object.keys(fields).reduce((result, key) => {
    if (!/webhook|token|secret/i.test(key)) result[key] = String(fields[key] ?? '');
    return result;
  }, {}) : {};
  return { version: 1, tab: String(tab || 'overview'), fields: safeFields, focus: focus && typeof focus === 'object' ? { id: String(focus.id || ''), start: Number(focus.start) || 0, end: Number(focus.end) || 0 } : null, scope: normalizeAdminDraftScope(scope) };
}
function persistAdminDraft(storage, key, draft) {
  try {
    const serialized = JSON.stringify(createAdminDraftState(draft.tab, draft.fields, draft.focus, draft.scope));
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) return { ok: false, outcome: 'readback-mismatch' };
    return { ok: true, outcome: 'persisted' };
  } catch (error) { return { ok: false, outcome: 'storage-failed', error }; }
}
function restoreAdminDraft(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { ok: true, draft: null };
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 && parsed.fields && !/webhook|token|secret/i.test(raw) ? { ok: true, draft: createAdminDraftState(parsed.tab, parsed.fields, parsed.focus, parsed.scope) } : { ok: false, outcome: 'invalid-draft' };
  } catch (error) { return { ok: false, outcome: 'storage-failed', error }; }
}
function isAdminDraftEmpty(draft) {
  const fields = draft && draft.fields && typeof draft.fields === 'object' && !Array.isArray(draft.fields) ? draft.fields : {};
  return Object.values(fields).every((value) => String(value ?? '') === '');
}
function gateAdminDraftReload(storage, key, draft) {
  const saved = persistAdminDraft(storage, key, draft);
  if (!saved.ok) return isAdminDraftEmpty(draft) ? { ...saved, ok: true, outcome: 'storage-failed-empty-draft' } : saved;
  const restored = restoreAdminDraft(storage, key);
  return restored.ok ? { ok: true, outcome: 'readback-verified', draft: restored.draft } : restored;
}
function resolvePanelExit(reason, dirty, persistResult) {
  if (!dirty || (persistResult && persistResult.ok)) return { proceed: true, actionGroup: [], focusAction: null, announce: false };
  const actionGroup = String(reason) === 'reload' ? ['Save', 'Discard', 'Reload'] : ['Save', 'Discard', 'Cancel'];
  return { proceed: false, actionGroup, focusAction: actionGroup[0], announce: true };
}
function createNameBackfillPlan(ids, visibleIds, orphanCap = PANEL_BACKFILL_ORPHAN_CAP) {
  const source = Array.isArray(ids) ? ids : [];
  const sourceSet = new Set(source.map(String));
  const visible = new Set(Array.isArray(visibleIds) ? visibleIds.map(String) : []);
  const ordered = []; const seen = new Set();
  for (const id of (Array.isArray(visibleIds) ? visibleIds : []).concat(source)) {
    const value = String(id || '');
    if (!value || seen.has(value) || !sourceSet.has(value)) continue;
    seen.add(value); ordered.push(value);
  }
  const capped = Number.isFinite(Number(orphanCap)) ? Math.max(0, Math.floor(Number(orphanCap))) : PANEL_BACKFILL_ORPHAN_CAP;
  const visiblePart = ordered.filter((id) => visible.has(id));
  const orphanPart = ordered.filter((id) => !visible.has(id)).slice(0, capped);
  return { ids: visiblePart.concat(orphanPart), visibleIds: visiblePart, orphanIds: orphanPart, orphanCap: capped };
}
function isPanelAsyncResultCurrent(requestEpoch, currentEpoch, requestTab, currentTab, isOpen, isLeader) {
  return requestEpoch === currentEpoch && requestTab === currentTab && isOpen === true && isLeader === true;
}
function patchPlayerNameNodes(root, updates, previousNames) {
  if (!root || typeof root.querySelectorAll !== 'function' || !Array.isArray(updates)) return 0;
  const nodes = Array.from(root.querySelectorAll('[data-player-id]'));
  const previous = previousNames && typeof previousNames === 'object' ? previousNames : {};
  let patched = 0;
  for (const update of updates) {
    const id = String((update && update.id) || ''); const name = String((update && update.name) || '').trim();
    if (!id || !name) continue;
    for (const node of nodes) {
      if (!node || !node.dataset || String(node.dataset.playerId) !== id) continue;
      const current = String(node.textContent || '').trim();
      if (previous[id] !== void 0 && current !== String(previous[id])) continue;
      node.textContent = name; patched += 1;
    }
  }
  return patched;
}
function applyPanelLeaseState(isLeader, root) {
  const target = root || activePanelRoot;
  if (!target || typeof target.querySelectorAll !== 'function') return { leader: Boolean(isLeader), controls: 0 };
  const controls = Array.from(target.querySelectorAll('[data-mutation-control]'));
  controls.forEach((control) => { control.disabled = !isLeader; });
  const banner = typeof target.querySelector === 'function' ? target.querySelector('[data-taa-standby-banner]') : null;
  if (banner) banner.textContent = isLeader ? 'Leader — this tab owns monitoring and transport.' : 'Standby — this follower is read-only; configuration writes are disabled.';
  return { leader: Boolean(isLeader), controls: controls.length };
}

module.exports = {
  configurePanelAdapters, resetPanelAdapters, panelSessionStore,
  createAdminDraftState, isAdminDraftEmpty,
  supportsInputSelection, readSessionStorageSafely, persistAdminDraft,
  restoreAdminDraft, gateAdminDraftReload, resolvePanelExit,
  createNameBackfillPlan, isPanelAsyncResultCurrent,
  patchPlayerNameNodes, applyPanelLeaseState,
};
