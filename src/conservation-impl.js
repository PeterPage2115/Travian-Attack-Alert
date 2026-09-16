'use strict';

// Conservation facade (plan Todo 13).
//
// Holds no independent logic: every symbol re-exports the Todo 12
// implementation module that owns it (monitor lineage and compaction from
// src/envelope-impl.js, source identity from src/migration-impl.js), so the
// cross-contract duplicates are eliminated by reference rather than copied.
// The legacy authority in src/runtime.js is byte-untouched in this task;
// differential behavior is pinned by
// test/characterization/dispatch-conservation.test.cjs.
const {
  coalesceMonitorPendingEvents, compactDeliveryAccountingV1,
  prepareTerminalCompactionV1, resumeTerminalCompactionV1,
  createMonitorQueueEvent,
} = require('./envelope-impl.js');
const { sourceEventIdFromTuple, sourceEventTuple } = require('./migration-impl.js');

module.exports = {
  sourceEventIdFromTuple, sourceEventTuple,
  createMonitorQueueEvent, coalesceMonitorPendingEvents,
  compactDeliveryAccountingV1, prepareTerminalCompactionV1,
  resumeTerminalCompactionV1,
};
