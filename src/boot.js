'use strict';

const routeApi = /** @type {{ classifyAllianceRoute: (href: string) => { role: string }, ROUTE_ROLES: { CANONICAL_MEMBER: string } }} */ (require('./route.js'));

function bootBrowser(adapters) {
    const route = routeApi.classifyAllianceRoute(adapters.href);
    if (route.role !== routeApi.ROUTE_ROLES.CANONICAL_MEMBER) {
        if (typeof adapters.guidance === 'function') adapters.guidance(route);
        return { role: route.role, started: false };
    }
    if (adapters.webLocksAvailable !== true) {
        if (typeof adapters.guidance === 'function') adapters.guidance(route);
        return { role: route.role, started: false };
    }
    if (typeof adapters.startLifecycle !== 'function') {
        return { role: route.role, started: false };
    }
    adapters.startLifecycle({ route, lease: adapters.lease, monitor: adapters.monitor, transport: adapters.transport });
    return { role: route.role, started: true };
}

module.exports = { bootBrowser };
