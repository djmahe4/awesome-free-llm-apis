import { describe, it, expect } from 'vitest';
import { createExpressApp } from '../src/server.js';
import type { AddressInfo } from 'node:net';

describe('GET /api/tool-docs/:name', () => {
  it('returns documentation markdown for a given tool', async () => {
    const app = createExpressApp();
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/tool-docs/coding_agents`);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.tool).toBe('coding_agents');
      expect(typeof data.markdown).toBe('string');
      expect(data.markdown.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
