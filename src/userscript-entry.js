'use strict';

// Dual-mode entry: the dist bundle must work both as a Tampermonkey
// userscript (browser globals present -> start the live runtime) and as a
// Node module (require'd by artifact tests -> expose the runtime contract
// instead of touching browser globals, mirroring the old script.txt
// `if (!isNodeEnvironment)` browser start + Node exports behavior).

const runtime = require('./runtime.js');

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
    runtime.startBrowserRuntime();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = runtime;
}
