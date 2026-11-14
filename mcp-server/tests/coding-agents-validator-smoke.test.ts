import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

describe('subagent-validator smoke test on isolated repo', () => {
  it('triggers validator on large change zone, validates assumptions, and benchmarks durationMs', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-smoke-validator-'));
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.mkdir(path.join(ws, 'tests'), { recursive: true });
    await fs.mkdir(path.join(ws, '.free-llm-mcp'), { recursive: true });

    // Enable hypothesisGate on enforce, subagentValidation on true
    await fs.writeFile(
      path.join(ws, '.free-llm-mcp/coding-agents.json'),
      JSON.stringify({ hypothesisGate: 'enforce', subagentValidation: true })
    );

    // Create 12 files to establish a large change zone
    for (let i = 1; i <= 10; i++) {
      await fs.writeFile(path.join(ws, `src/module${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
    }
    await fs.writeFile(
      path.join(ws, 'src/main.ts'),
      'import { fn1 } from "./module1.js";\nexport function run() { return fn1(); }\n'
    );
    await fs.writeFile(
      path.join(ws, 'tests/main.test.ts'),
      'import { run } from "../src/main.js";\ntest("runs", () => { expect(run()).toBe(1); });\n'
    );

    const start = Date.now();
    const result = await CodingAgentsHandler({
      goal: 'call missingHelper() in src/main.ts and update tests',
      workspaceRoot: ws,
      targetFiles: ['src/main.ts', 'src/module1.ts', 'tests/main.test.ts'],
      dryRun: true,
      sessionId: `smoke-${Date.now()}`,
    });
    const totalTime = Date.now() - start;

    expect(result.durationMs).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThanOrEqual(totalTime + 100);

    // The gate must catch the refuted symbol missingHelper
    const refuted = (result.diagnostics || []).some(
      d => /missingHelper/i.test(d.message) && (d.source === 'hypothesis' || d.severity === 'error')
    );
    expect(refuted).toBe(true);
    expect(result.status).toBe('paused');

    await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
