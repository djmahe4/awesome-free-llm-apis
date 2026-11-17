import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalModelLock } from '../src/utils/local-model-lock.js';
import { extractMemoryHint, MEMORY_HINT_RULES } from '../src/middleware/memory-hint.js';

describe('PR 1 Safety & Promotion Unit Tests', () => {
  describe('LocalModelLock (VRAM guard)', () => {
    it('executes a single run and releases lock immediately', async () => {
      const lock = LocalModelLock.getInstance();
      let executed = false;

      const res = await lock.runWithLock(async () => {
        expect(lock.isLocked()).toBe(true);
        executed = true;
        return 42;
      });

      expect(res).toBe(42);
      expect(executed).toBe(true);
      expect(lock.isLocked()).toBe(false);
    });

    it('queues concurrent calls sequentially without VRAM collision', async () => {
      const lock = LocalModelLock.getInstance();
      const executionOrder: number[] = [];

      const run1 = lock.runWithLock(async () => {
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push(1);
      });

      const run2 = lock.runWithLock(async () => {
        executionOrder.push(2);
      });

      await Promise.all([run1, run2]);

      expect(executionOrder).toEqual([1, 2]);
      expect(lock.isLocked()).toBe(false);
    });

    it('rejects on abort signal', async () => {
      const lock = LocalModelLock.getInstance();
      const controller = new AbortController();
      controller.abort();

      await expect(lock.acquire(1000, controller.signal)).rejects.toThrow('aborted');
    });
  });

  describe('MemoryHintMiddleware', () => {
    it('matches "plan" and suggests adr_list and eisenhower_list', () => {
      const hint = extractMemoryHint(['We need to plan our next migration']);
      expect(hint).not.toBeNull();
      expect(hint?.suggestedTool).toBe('manage_memory');
      expect(hint?.actions).toContain('adr_list');
      expect(hint?.actions).toContain('eisenhower_list');
    });

    it('matches "architecture" and suggests adr_list and wiki_search', () => {
      const hint = extractMemoryHint(['System architecture review']);
      expect(hint).not.toBeNull();
      expect(hint?.actions).toContain('adr_list');
      expect(hint?.actions).toContain('wiki_search');
    });

    it('matches "refactor" and suggests graph_query', () => {
      const hint = extractMemoryHint(['We should refactor the auth middleware']);
      expect(hint).not.toBeNull();
      expect(hint?.actions).toContain('graph_query');
    });

    it('returns null when no memory keywords match', () => {
      const hint = extractMemoryHint(['Quick typo fix on line 12']);
      expect(hint).toBeNull();
    });

    it('ignores word fragments like "plant" or "commentary" if strict word boundary', () => {
      const plantHint = extractMemoryHint(['water the plant']);
      expect(plantHint).toBeNull();
    });
  });
});
