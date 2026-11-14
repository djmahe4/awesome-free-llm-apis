import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reverseTool, type ReverseScanGithubData } from '../src/tools/reverse-tool.js';
import { mockFetch } from './helpers/mock-fetch.js';

describe('reverseTool scan_github action', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-tool-gh-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects scan_github if authorization framing is missing', async () => {
    const res = await reverseTool({
      action: 'scan_github',
      target: 'owner/repo',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Target analysis requires authorization framing: "ctf" | "lab" | "consent".');
  });

  it('rejects scan_github if target is missing', async () => {
    const res = await reverseTool({
      action: 'scan_github',
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Target is required.');
  });

  it('returns error when target format is invalid', async () => {
    const res = await reverseTool({
      action: 'scan_github',
      target: 'not-a-repo',
      authorization: 'lab',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid GitHub repository target: "not-a-repo". Expected "owner/repo" or "https://github.com/owner/repo".');
  });

  it('returns error when tree fetch encounters network error', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: 'api.github.com/repos/owner/sample/releases',
        body: [],
      },
      {
        match: 'api.github.com/repos/owner/sample/git/trees/main',
        status: 500,
        body: 'Internal Server Error',
      },
    ]);

    const res = await reverseTool({
      action: 'scan_github',
      target: 'owner/sample',
      authorization: 'lab',
      options: {
        fetchImpl,
        storageDir: tmpDir,
      },
    });

    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).toContain('HTTP 500');
  });

  it('succeeds with tree analysis but records limitation when releases fetch fails', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: 'api.github.com/repos/owner/sample/releases',
        status: 500,
        body: 'Releases service unavailable',
      },
      {
        match: 'api.github.com/repos/owner/sample/git/trees/main',
        body: {
          sha: 'abcdef1234567890',
          truncated: false,
          tree: [{ path: 'README.md', type: 'blob' }],
        },
      },
      {
        match: 'raw.githubusercontent.com/owner/sample/abcdef1234567890/README.md',
        body: '# Sample Repo',
      },
    ]);

    const res = await reverseTool({
      action: 'scan_github',
      target: 'owner/sample',
      authorization: 'consent',
      options: {
        fetchImpl,
        storageDir: tmpDir,
      },
    });

    expect(res.success).toBe(true);
    expect(res.evidence).toBeDefined();
    expect(res.evidence?.limitations).toBeDefined();
    expect(res.evidence?.limitations.length).toBeGreaterThan(0);
    expect(res.evidence?.limitations[0]).toMatch(/500|releases/i);
    const data = res.data as ReverseScanGithubData;
    expect(data.releaseAssets).toEqual([]);
    expect(data.commitSha).toBe('abcdef1234567890');
  });

  it('respects options.ref or options.branch for tree indexing', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: 'api.github.com/repos/owner/sample/releases',
        body: [],
      },
      {
        match: 'api.github.com/repos/owner/sample/git/trees/develop',
        body: {
          sha: 'develop123456',
          truncated: false,
          tree: [{ path: 'README.md', type: 'blob' }],
        },
      },
      {
        match: 'raw.githubusercontent.com/owner/sample/develop123456/README.md',
        body: '# Develop Branch',
      },
    ]);

    const res = await reverseTool({
      action: 'scan_github',
      target: 'owner/sample',
      authorization: 'lab',
      options: {
        fetchImpl,
        storageDir: tmpDir,
        ref: 'develop',
      },
    });

    expect(res.success).toBe(true);
    const data = res.data as ReverseScanGithubData;
    expect(data.commitSha).toBe('develop123456');
  });

  it('executes scan_github, returns release assets, descriptors, and stores evidence', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: 'api.github.com/repos/owner/sample/git/trees/main',
        body: {
          sha: '1234567890abcdef',
          truncated: false,
          tree: [
            { path: 'README.md', type: 'blob' },
            { path: 'src/main.ts', type: 'blob' },
            { path: '.claude/skills/test/SKILL.md', type: 'blob' },
          ],
        },
      },
      {
        match: 'api.github.com/repos/owner/sample/releases',
        body: [
          {
            id: 1,
            tag_name: 'v1.0.0',
            assets: [{ id: 10, name: 'binary.elf', size: 50000, content_type: 'application/octet-stream' }],
          },
        ],
      },
      {
        match: 'raw.githubusercontent.com/owner/sample/1234567890abcdef/README.md',
        body: '# Sample Repo\nProduction ready.',
      },
      {
        match: 'raw.githubusercontent.com/owner/sample/1234567890abcdef/src/main.ts',
        body: 'export function boot() { console.log("booting"); }',
      },
    ]);

    const res = await reverseTool({
      action: 'scan_github',
      target: 'https://github.com/owner/sample',
      authorization: 'consent',
      options: {
        fetchImpl,
        storageDir: tmpDir,
      },
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('scan_github');
    expect(res.evidence).toBeDefined();
    expect(res.evidence?.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);

    const data = res.data as ReverseScanGithubData;
    expect(data.commitSha).toBe('1234567890abcdef');
    expect(data.releaseAssets).toHaveLength(1);
    expect(data.releaseAssets[0].name).toBe('binary.elf');
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].name).toBe('test');
  });
});
