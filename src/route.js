'use strict';

/** URL authority classification is pure and precedes lifecycle side effects. */
const ROUTE_ROLES = Object.freeze({
    CANONICAL_MEMBER: 'canonical-member',
    ALLIANCE_NONCANONICAL: 'alliance-noncanonical',
    UNSUPPORTED: 'unsupported'
});
function classifyAllianceRoute(input) {
    let url;
    try { url = new URL(String(input)); } catch { return { role: ROUTE_ROLES.UNSUPPORTED, pathname: '', query: '' }; }
    const pathname = url.pathname;
    const canonical = pathname === '/alliance/profile/members' || pathname === '/alliance/profile/members/';
    if (canonical && url.search === '') return { role: ROUTE_ROLES.CANONICAL_MEMBER, pathname, query: url.search };
    if (pathname === '/alliance' || pathname.startsWith('/alliance/')) return { role: ROUTE_ROLES.ALLIANCE_NONCANONICAL, pathname, query: url.search };
    return { role: ROUTE_ROLES.UNSUPPORTED, pathname, query: url.search };
}
function lockNameForHostname(hostname) { return `taa-monitor:${String(hostname || '').trim().toLowerCase().replace(/\.+$/, '')}`; }
module.exports = { ROUTE_ROLES, classifyAllianceRoute, lockNameForHostname };
