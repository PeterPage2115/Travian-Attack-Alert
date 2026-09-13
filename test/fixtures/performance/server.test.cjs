'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, pageHtml, playerRows } = require('./server.cjs');

test('performance fixture serves the production alliance member table shape', async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/alliance/profile/members`);
        const html = await response.text();
        assert.equal(response.status, 200);
        assert.match(html, /<table class="allianceMembers">/);
        assert.equal((playerRows().match(/<tr>/g) || []).length, 60);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
