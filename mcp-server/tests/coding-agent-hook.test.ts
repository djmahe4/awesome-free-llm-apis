import { describe, it, expect } from 'vitest';
import { ContextInjectionHook } from '../src/harness/context-injection-hook.js';

describe('ContextInjectionHook fromTasksFile', () => {
  it('does not throw on missing tasks.md path', async () => {
    const hook = ContextInjectionHook.fromTasksFile('/nonexistent/tasks.md', { foldByDefault: true });
    const result = await hook.before({
      tool: 'coding_agents', action: 'plan', goal: 'add feature', thoughts: []
    });
    expect(result.injectedContext).toBeDefined();
  });
});
