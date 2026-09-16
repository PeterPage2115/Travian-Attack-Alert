'use strict';

// Runtime contract index (plan Todo 17).
//
// Direct re-exports of the 13 domain facades. Each domain module owns its
// symbols directly; the select() indirection over the legacy runtime
// authority is removed. Every domain object below IS the facade module
// itself (reference-equal), never a copied subset.
module.exports = {
  storage: require('./storage.js'),
  lease: require('./lease.js'),
  parser: require('./parser.js'),
  snapshot: require('./snapshot.js'),
  envelope: require('./envelope.js'),
  migration: require('./migration.js'),
  discord: require('./discord.js'),
  transport: require('./transport.js'),
  dispatch: require('./dispatch.js'),
  conservation: require('./conservation.js'),
  diagnostics: require('./diagnostics.js'),
  panel: require('./panel.js'),
  acquisition: require('./acquisition.js'),
};
