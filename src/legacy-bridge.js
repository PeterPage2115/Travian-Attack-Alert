'use strict';

/** @typedef {Record<string, unknown>} LegacyModuleExports */

/**
 * The generated userscript is the browser/runtime authority.  Domain barrels
 * consume its named contracts without importing browser globals or retaining a
 * second boot implementation.
 * @returns {LegacyModuleExports}
 */
function loadLegacy() {
    const load = eval('require');
    return /** @type {LegacyModuleExports} */ (load('../script.txt'));
}

/**
 * Select an explicit public contract without copying or wrapping behaviour.
 * @param {readonly string[]} names
 * @returns {LegacyModuleExports}
 */
function select(names) {
    const legacy = loadLegacy();
    return Object.fromEntries(names.map(name => [name, legacy[name]]));
}

module.exports = { loadLegacy, select };
