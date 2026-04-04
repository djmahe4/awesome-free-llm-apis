import { describe, it, expect } from 'vitest';
import { executeInSandbox } from '../src/sandbox/executor.js';

describe('QuickJS Sandbox', () => {
  it('basic print() returns stdout', async () => {
    const result = await executeInSandbox('print("hello world")');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello world');
  });

  it('DATA variable is accessible', async () => {
    const result = await executeInSandbox('print(DATA)', { data: 'my-test-data' });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('my-test-data');
  });

  it('handles syntax errors gracefully', async () => {
    const result = await executeInSandbox('this is not valid JS %%%');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('captures multiple print calls', async () => {
    const result = await executeInSandbox('print("line1"); print("line2")');
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line2');
  });

  it('timeout works for infinite loops', async () => {
    const result = await executeInSandbox('while(true){}', { timeoutMs: 100 });
    expect(result.success).toBe(false);
  }, 10000);

  it('no process or require available (sandboxed)', async () => {
    const result = await executeInSandbox('print(typeof process)', { language: 'javascript' });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('undefined');
  });

  it('JSON operations work', async () => {
    const data = JSON.stringify({ name: 'test', value: 42 });
    const code = 'var obj = JSON.parse(DATA); print(obj.name + ":" + obj.value)';
    const result = await executeInSandbox(code, { data });
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('test:42');
  });
});
