import { describe, it, expect } from 'vitest';
import { extractServerActions, extractPlaygroundActions, extractQuickstartActionRows, findActionDrift } from '../scripts/verification/action-sync.js';

const toolsBlock = `
  {
    name: 'cyber_tool',
    inputSchema: { properties: {
      action: { type: 'string', enum: ['list_tools', 'resolve_tool'], description: 'x' },
      nested: { properties: { action: { type: 'string', enum: ['inner'] } } },
    } },
  },
  {
    name: 'other_tool',
    inputSchema: { properties: { q: { type: 'string' } } },
  },
`;
const registered = new Set(['cyber_tool', 'other_tool']);

describe('action-sync', () => {
  it('reads the top-level action enum and ignores tools without one', () => {
    expect(extractServerActions(toolsBlock, registered)).toEqual({ cyber_tool: ['list_tools', 'resolve_tool'] });
  });

  it('reads playground select options, ignoring the empty "no action" option', () => {
    const app = `const TOOLS = [\n  {\n    id: 'cyber_tool', label: 'x',\n    fields: [\n      { id: 'action', label: 'A', type: 'select', options: ['', 'list_tools'] },\n    ]\n  },\n];\nlet activeTool = TOOLS[0];`;
    expect(extractPlaygroundActions(app)).toEqual({ cyber_tool: ['list_tools'] });
  });

  it('reads the Quickstart action row', () => {
    const html = '<details class="qs-tool-card"><summary><span class="qs-tool-name">cyber_tool</span></summary><table><tr><td><code>action</code></td><td>enum</td><td>list_tools | resolve_tool</td></tr></table>';
    expect(extractQuickstartActionRows(html).cyber_tool).toContain('resolve_tool');
  });

  it('reports a missing action in either place, and nothing when in sync', () => {
    const server = { cyber_tool: ['list_tools', 'resolve_tool'] };
    expect(findActionDrift(server, { cyber_tool: ['list_tools'] }, { cyber_tool: 'list_tools | resolve_tool' }))
      .toEqual(['[cyber_tool] playground action select is missing: resolve_tool']);
    expect(findActionDrift(server, { cyber_tool: ['list_tools', 'resolve_tool'] }, { cyber_tool: '<td>list_tools</td>' }))
      .toEqual(['[cyber_tool] Quickstart action row is missing: resolve_tool']);
    expect(findActionDrift(server, { cyber_tool: ['list_tools', 'resolve_tool'] }, { cyber_tool: 'list_tools | resolve_tool' })).toEqual([]);
  });

  it('does not treat a longer name as containing a shorter action (osint vs osint_status)', () => {
    expect(findActionDrift({ t: ['osint'] }, {}, { t: 'osint_status' })).toHaveLength(1);
  });
});
