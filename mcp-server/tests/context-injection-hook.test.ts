import { describe, it, expect } from 'vitest';
import { ContextInjectionHook } from '../src/harness/context-injection-hook.js';

describe('ContextInjectionHook', () => {
  it('injects folded summary when keyword absent', async () => {
    const hook = new ContextInjectionHook({ foldByDefault: true });
    const ctx = { tool: 'use_free_llm', action: 'query', goal: 'summarize paper', thoughts: [] };
    const result = await hook.before(ctx);
    expect(result.injectedContext.folded).toBe(true);
    expect(result.injectedContext.summary).toMatch(/\S+/);
  });

  it('expands bundle when trigger keyword matches action', async () => {
    const hook = new ContextInjectionHook({ triggers: ['analyze_artifact'] });
    const ctx = {
      tool: 'reverse_tool', action: 'analyze_artifact',
      goal: 'analyze_artifact target',
      thoughts: [{ id: 't1', text: 'load binary', source: 'rea' as const, timestamp: 0 }]
    };
    const result = await hook.before(ctx);
    expect(result.injectedContext.folded).toBe(false);
    expect(result.injectedContext.thoughts).toHaveLength(1);
  });

  it('injects prefill thoughts from tasks file when created via fromTasksFile', async () => {
    const hook = ContextInjectionHook.fromTasksFile('/nonexistent/tasks.md', { foldByDefault: true });
    const result = await hook.before({
      tool: 'coding_agents', action: 'plan', goal: 'add feature', thoughts: []
    });
    expect(result.injectedContext).toBeDefined();
  });

  it('after() records a rea thought bundle from tool result', async () => {
    const hook = new ContextInjectionHook();
    const bundle = await hook.after(
      { tool: 'reverse_tool', action: 'analyze_artifact', goal: 'inspect elf', thoughts: [] },
      { ok: true, note: 'parsed header' }
    );
    expect(bundle).not.toBeNull();
    expect(bundle?.source).toBe('rea');
    expect(bundle?.text).toMatch(/\S+/);
  });
});
