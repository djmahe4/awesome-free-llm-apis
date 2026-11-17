import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeDir } from './helpers/temp-dir.js';
import {
  loadToolDescriptions,
  loadToolIndex,
  enrichToolsWithDescriptions,
  resetToolIndexCache,
} from '../src/utils/cyber-tools-index.js';

describe('cyber-tools-index', () => {
  let dir: string;
  let emptyDir: string | null = null;

  beforeEach(async () => {
    resetToolIndexCache();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-index-'));
    await fs.writeFile(
      path.join(dir, 'tools_config.json'),
      JSON.stringify([
        { name: 'sqlmap', description: 'automating SQL injection and database takeover', module: 'web', url: 'https://github.com/sqlmapproject/sqlmap' },
        { name: 'nmap', description: 'network scanning tool for discovering hosts', module: 'recon' },
        { name: 'no-desc' },
        { bad: true },
      ]),
      'utf-8',
    );
  });

  afterEach(async () => {
    if (dir) await removeDir(dir).catch(() => {});
    if (emptyDir) await removeDir(emptyDir).catch(() => {});
    emptyDir = null;
  });

  it('loads name→description pairs and skips malformed entries', async () => {
    const index = await loadToolIndex(dir);
    expect(index.size).toBe(3);
    expect(index.get('sqlmap')?.description).toContain('SQL injection');
    expect(index.get('no-desc')?.description).toBeUndefined();

    const descriptions = await loadToolDescriptions(dir);
    expect(descriptions.sqlmap).toContain('SQL injection');
    expect(descriptions.nmap).toContain('network scanning');
    expect(descriptions['no-desc']).toBeUndefined();
  });

  it('enriches list_tools-style maps without mutating the input', async () => {
    const tools = {
      sqlmap: { url: 'https://github.com/sqlmapproject/sqlmap' },
      nmap: { url: 'https://github.com/nmap/nmap' },
      bare: { url: 'u' },
    };
    const enriched = await enrichToolsWithDescriptions(tools, dir) as Record<string, any>;
    expect(enriched.sqlmap.description).toContain('SQL injection');
    expect(enriched.nmap.description).toContain('network scanning');
    expect(enriched.bare).toEqual({ url: 'u' });
    expect(tools.sqlmap).toEqual({ url: 'https://github.com/sqlmapproject/sqlmap' });
  });

  it('returns empty maps when tools_config.json is absent', async () => {
    emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-index-empty-'));
    resetToolIndexCache();
    expect(await loadToolDescriptions(emptyDir)).toEqual({});
    expect(await enrichToolsWithDescriptions({ a: { url: 'u' } }, emptyDir)).toEqual({ a: { url: 'u' } });
  });
});
