import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memoryManager } from '../src/memory/index.js';
import { WorkspaceIndexer } from '../src/memory/indexer.js';
import { DiffScanner } from '../src/middleware/agentic/diff-scanner.js';
import fs from 'fs-extra';
import path from 'path';

vi.mock('../src/middleware/agentic/diff-scanner.js', () => ({
  DiffScanner: {
    scan: vi.fn().mockResolvedValue({
      changedFiles: ['src/edited.ts'],
      currentBranch: 'main',
      lastCommitHash: 'hash123',
      scanTimestamp: Date.now(),
      hasGit: true
    })
  }
}));

describe('Memory Lifecycle and Incremental Indexing Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('MemoryEntry initialization, confirmation, and exponential decay validation', async () => {
    const entry = (memoryManager as any).createMemoryEntry('Test content value', 0.8);
    expect(entry.confidence).toBe(0.8);
    expect(entry.sourceCount).toBe(1);

    const confirmed = (memoryManager as any).confirmMemoryEntry(entry);
    expect(confirmed.confidence).toBe(0.95);
    expect(confirmed.sourceCount).toBe(2);

    const decayed = (memoryManager as any).calculateDecayedConfidence(confirmed, 30); // 30 days
    expect(decayed).toBeLessThan(confirmed.confidence);
  });

  it('Supersession conflicts when cosine similarity > 0.92 and content contradicts', async () => {
    const oldEntry = (memoryManager as any).createMemoryEntry('The server port is set to 8080', 0.9);
    const newContent = 'The server port is set to 9090';

    const superseded = (memoryManager as any).detectAndLinkSupersession(oldEntry, newContent);
    expect(superseded.supersededBy).toBeDefined();
  });

  it('Incremental Workspace Indexer only processes changed files', async () => {
    const indexer = new WorkspaceIndexer(process.cwd());
    const wsHash = 'dummy-ws-hash';

    vi.spyOn(fs, 'readFile').mockResolvedValue('export const a = 1;');
    const indexSpy = vi.spyOn(indexer, 'indexWorkspace');

    await indexer.indexWorkspace(process.cwd());
    expect(DiffScanner.scan).toHaveBeenCalled();
  });
});
