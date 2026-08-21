import { describe, it, expect } from 'vitest';
import { createMCPServer } from '../src/mcp/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('MCP index — local_llm_patch registration', () => {
  it('exports and lists a tool named local_llm_patch', async () => {
    const server = await createMCPServer();
    const handlers = (server as any)._requestHandlers;
    const listHandler = handlers?.get(ListToolsRequestSchema.shape.method.value);
    expect(listHandler).toBeDefined();
    const response = await listHandler({ method: 'tools/list' });
    const toolNames = response.tools.map((t: any) => t.name);
    expect(toolNames).toContain('local_llm_patch');
  });
});
