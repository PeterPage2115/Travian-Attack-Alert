'use strict';

const runtimeApi = require('./runtime-api.js');
const runtime = require('./runtime.js');

function loadLegacy() {
    return Object.fromEntries(Object.entries(runtime).filter(([name]) => name !== 'startBrowserRuntime'));
}

/**
 * Select an explicit public contract without copying or wrapping behaviour.
 * @param {readonly string[]} names
 * @returns {Record<string, unknown>}
 */
function select(names) {
    return runtimeApi.select('legacy-bridge', names);
}

module.exports = { loadLegacy, select };
