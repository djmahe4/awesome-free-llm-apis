import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  SymbolGraph,
  SymbolGraphCache,
  buildSymbolGraph,
  buildSymbolContextBlock,
  computeSha8,
} from '../src/tools/coding-agents/symbol-graph-cache.js';

describe('symbol-graph-cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'symbol-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe('Export extraction', () => {
    it('extracts exported functions, classes, and variables in TypeScript', async () => {
      const files = new Map<string, string>([
        [
          'src/math.ts',
          `
          export function add(a: number, b: number): number { return a + b; }
          export const PI = 3.14159;
          export class Calculator {
            operate() {}
          }
          function privateHelper() { return false; }
          `,
        ],
      ]);

      const graph = await buildSymbolGraph('/mock/workspace', files);
      const exports = graph.getExports('src/math.ts');

      expect(exports).toContain('add');
      expect(exports).toContain('PI');
      expect(exports).toContain('Calculator');
      expect(exports).not.toContain('privateHelper');
    });

    it('extracts exports from Python files', async () => {
      const files = new Map<string, string>([
        [
          'services/data.py',
          `
          def fetch_records():
              return []

          class RecordProcessor:
              pass
          `,
        ],
      ]);

      const graph = await buildSymbolGraph('/mock/workspace', files);
      const exports = graph.getExports('services/data.py');

      expect(exports).toContain('fetch_records');
      expect(exports).toContain('RecordProcessor');
    });
  });

  describe('Content-hash caching (sha8)', () => {
    it('produces expected 8-character sha8 hash', () => {
      const content = 'export const test = 123;';
      const hash = computeSha8(content);
      expect(hash).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(hash)).toBe(true);
    });

    it('records cache hit on identical hash', async () => {
      const cache = new SymbolGraphCache(50);
      const content = 'export function doSomething(): void {}';
      const files = new Map<string, string>([['src/actions.ts', content]]);

      expect(cache.hits).toBe(0);
      expect(cache.misses).toBe(0);

      // First pass: cache miss
      const graph1 = await buildSymbolGraph('/mock/workspace', files, cache);
      expect(cache.hits).toBe(0);
      expect(cache.misses).toBe(1);
      expect(graph1.getExports('src/actions.ts')).toContain('doSomething');

      // Second pass with identical content: cache hit
      const graph2 = await buildSymbolGraph('/mock/workspace', files, cache);
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(1);
      expect(graph2.getExports('src/actions.ts')).toContain('doSomething');
    });

    it('records cache miss on content change', async () => {
      const cache = new SymbolGraphCache(50);
      const v1 = 'export function compute(): number { return 1; }';
      const v2 = 'export function compute(): number { return 2; }\nexport function secondary(): void {}';

      // Pass 1: v1
      await buildSymbolGraph('/mock/workspace', new Map([['src/compute.ts', v1]]), cache);
      expect(cache.hits).toBe(0);
      expect(cache.misses).toBe(1);

      // Pass 2: identical v1 -> hit
      await buildSymbolGraph('/mock/workspace', new Map([['src/compute.ts', v1]]), cache);
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(1);

      // Pass 3: modified content v2 -> miss
      const graph3 = await buildSymbolGraph('/mock/workspace', new Map([['src/compute.ts', v2]]), cache);
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(2);
      expect(graph3.getExports('src/compute.ts')).toEqual(['compute', 'secondary']);
    });

    it('evicts least recently set entries when bounded limit is exceeded', () => {
      const cache = new SymbolGraphCache(2);
      cache.set({ filePath: 'f1.ts', hash: '11111111', exports: ['a'], imports: [], size: 10 });
      cache.set({ filePath: 'f2.ts', hash: '22222222', exports: ['b'], imports: [], size: 20 });
      expect(cache.has('11111111')).toBe(true);

      // Add 3rd item -> oldest (11111111) evicted
      cache.set({ filePath: 'f3.ts', hash: '33333333', exports: ['c'], imports: [], size: 30 });
      expect(cache.has('11111111')).toBe(false);
      expect(cache.has('22222222')).toBe(true);
      expect(cache.has('33333333')).toBe(true);
    });
  });

  describe('Caller resolution', () => {
    it('resolves callers by symbol and target file', async () => {
      const files = new Map<string, string>([
        [
          'src/math.ts',
          `
          export function add(a: number, b: number): number { return a + b; }
          export function multiply(a: number, b: number): number { return a * b; }
          `,
        ],
        [
          'src/main.ts',
          `
          import { add } from './math.js';
          const result = add(2, 3);
          `,
        ],
        [
          'src/service.ts',
          `
          import { add, multiply } from './math.js';
          export function run() {
            add(1, 2);
            multiply(3, 4);
          }
          `,
        ],
      ]);

      const graph = await buildSymbolGraph('/mock/workspace', files);

      // Check caller resolution for symbol 'add'
      const addCallers = graph.getCallers('add');
      expect(addCallers).toContain('src/main.ts');
      expect(addCallers).toContain('src/service.ts');

      // Check caller resolution for symbol 'multiply'
      const multiplyCallers = graph.getCallers('multiply');
      expect(multiplyCallers).toContain('src/service.ts');
      expect(multiplyCallers).not.toContain('src/main.ts');

      // Check caller resolution for file 'src/math.ts'
      const fileCallers = graph.getCallers('src/math.ts');
      expect(fileCallers).toContain('src/main.ts');
      expect(fileCallers).toContain('src/service.ts');
    });

    it('works with real files on disk', async () => {
      const utilsDir = path.join(tempDir, 'src');
      await fs.mkdir(utilsDir, { recursive: true });

      await fs.writeFile(
        path.join(utilsDir, 'helper.ts'),
        'export function sanitize(input: string): string { return input.trim(); }'
      );
      await fs.writeFile(
        path.join(utilsDir, 'app.ts'),
        `
        import { sanitize } from './helper.js';
        const clean = sanitize('  hello  ');
        `
      );

      const cache = new SymbolGraphCache(10);
      const graph = await buildSymbolGraph(tempDir, undefined, cache);

      expect(graph.getExports('src/helper.ts')).toContain('sanitize');
      expect(graph.getCallers('sanitize')).toContain('src/app.ts');
      expect(graph.getCallers('src/helper.ts')).toContain('src/app.ts');
    });
  });

  describe('buildSymbolContextBlock', () => {
    it('generates a structured markdown block with exports, callers, and dependencies', async () => {
      const files = new Map<string, string>([
        [
          'src/logger.ts',
          'export function log(msg: string): void {}',
        ],
        [
          'src/service.ts',
          `
          import { log } from './logger.js';
          export function processPayment(amount: number): boolean {
            log('Processing');
            return true;
          }
          `,
        ],
        [
          'src/controller.ts',
          `
          import { processPayment } from './service.js';
          processPayment(100);
          `,
        ],
      ]);

      const graph = await buildSymbolGraph('/mock/workspace', files);
      const block = buildSymbolContextBlock('src/service.ts', graph);

      expect(block).toContain('[Symbol Context: src/service.ts]');
      expect(block).toContain('processPayment');
      expect(block).toContain('src/controller.ts');
      expect(block).toContain('logger.js');
    });

    it('handles files with no exports or callers gracefully', async () => {
      const files = new Map<string, string>([
        ['src/standalone.ts', 'const a = 1;'],
      ]);

      const graph = await buildSymbolGraph('/mock/workspace', files);
      const block = buildSymbolContextBlock('src/standalone.ts', graph);

      expect(block).toContain('[Symbol Context: src/standalone.ts]');
      expect(block).toContain('No exported symbols, callers, or dependencies detected');
    });
  });
});
