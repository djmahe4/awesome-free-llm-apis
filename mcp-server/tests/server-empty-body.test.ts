import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createExpressApp } from '../src/server.js';

// Express 5 leaves req.body undefined when a request has no body (express 4 gave {}). A POST without a body must be
// answered by the handler's own validation, not by a TypeError from destructuring undefined.

let server: Server;
let base = '';
beforeAll(() => {
    server = createExpressApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

const ROUTES = ['/api/user-config', '/api/validate-provider', '/api/tool', '/api/coding_agents', '/api/browser_tool', '/api/cyber_tool', '/api/quantum_tool'];

describe('POST with no body', () => {
    it.each(ROUTES)('%s is not a 500 TypeError', async (route) => {
        const res = await fetch(base + route, { method: 'POST' });
        const text = await res.text();
        expect(text).not.toMatch(/Cannot destructure|of 'req\.body'|undefined is not|Cannot read properties of undefined/);
        expect(res.status).not.toBe(500);
        expect(res.status).not.toBe(404);
    });
});
