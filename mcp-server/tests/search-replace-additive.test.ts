import { describe, it, expect } from 'vitest';
import {
  parseSearchReplaceBlocks,
  applySearchReplaceBlocks,
  generateSearchReplacePatch,
} from '../src/tools/coding-agents.js';
import {
  recommendModels,
  searchModels,
  getModelInfo,
  resolveLlmFitExecutable,
} from '../src/services/llmfit.js';

describe('Search/Replace block parsing & additive edits', () => {
  it('parses well-formed SEARCH/REPLACE blocks', () => {
    const raw = [
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 1;',
      'const b = 2;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const blocks = parseSearchReplaceBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('const a = 1;');
    expect(blocks[0].replace).toBe('const a = 1;\nconst b = 2;');
  });

  it('handles empty-SEARCH without poisoning subsequent blocks', () => {
    const raw = [
      '<<<<<<< SEARCH',
      '=======',
      '// stray empty block',
      '>>>>>>> REPLACE',
      '',
      '<<<<<<< SEARCH',
      'const target = true;',
      '=======',
      'const target = false;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const blocks = parseSearchReplaceBlocks(raw);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe('');
    expect(blocks[1].search).toBe('const target = true;');
    expect(blocks[1].replace).toBe('const target = false;');

    // Applying should cleanly skip the empty search and apply the good one
    const result = applySearchReplaceBlocks('const target = true;', blocks);
    expect(result.appliedCount).toBe(1);
    expect(result.content).toBe('const target = false;');
    expect(result.failures).toContain('Empty SEARCH block (nothing to match)');
  });

  it('correctly executes additive insertions retaining original lines', () => {
    const original = [
      'import os from "node:os";',
      'import { useFreeLLM } from "./use-free-llm.js";',
      '',
      'export function run() {',
      '  return true;',
      '}',
    ].join('\n');

    const blocks = [
      {
        search: 'import { useFreeLLM } from "./use-free-llm.js";',
        replace: 'import { useFreeLLM } from "./use-free-llm.js";\nimport { TaskType } from "../pipeline/middleware.js";',
      },
    ];

    const result = applySearchReplaceBlocks(original, blocks);
    expect(result.appliedCount).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(result.content).toContain('import { TaskType } from "../pipeline/middleware.js";');
    expect(result.content).toContain('export function run() {');
  });

  it('generateSearchReplacePatch handles large files with additive edits cleanly', async () => {
    // Generate a ~300 line file
    const lines = Array.from({ length: 300 }, (_, i) => `export const val_${i} = ${i};`);
    const initialContent = lines.join('\n');

    const mockChat = async (prompt: string) => {
      // Ensure the prompt includes the new additive instructions
      expect(prompt).toContain('To ADD lines while retaining existing code');
      return [
        '<<<<<<< SEARCH',
        'export const val_50 = 50;',
        '=======',
        'export const val_50 = 50;',
        'export const val_50_ext = 50.5;',
        '>>>>>>> REPLACE',
      ].join('\n');
    };

    const res = await generateSearchReplacePatch(
      initialContent,
      'Add val_50_ext immediately after val_50',
      'test.ts',
      undefined,
      mockChat
    );

    expect(res.appliedCount).toBe(1);
    expect(res.failures).toHaveLength(0);
    expect(res.content).toContain('export const val_50_ext = 50.5;');
    expect(res.content).toContain('export const val_299 = 299;');
  });
});

describe('llmfit integration service', () => {
  it('resolves executable in venv/Scripts', () => {
    const { binaryPath, pythonPath } = resolveLlmFitExecutable();
    expect(binaryPath || pythonPath).toBeDefined();
  });

  it('retrieves recommend models for coding use case', async () => {
    const res = await recommendModels({ useCase: 'coding', limit: 2 });
    expect(res).toBeDefined();
    expect(res.models.length).toBeGreaterThan(0);
    expect(res.models[0].name).toBeDefined();
    expect(res.models[0].effectiveContextLength).toBeGreaterThan(0);
  });

  it('retrieves detailed model info with context lengths', async () => {
    const info = await getModelInfo('qwen2.5-coder:7b');
    expect(info).toBeDefined();
    if (info) {
      expect(info.name).toContain('Qwen2.5-Coder-7B');
      expect(info.contextLength).toBe(32768);
    }
  });
});
