import { describe, it, expect } from 'vitest';
import { RemoteRepoSource } from '../src/reverse/remote-repo-source.js';
import { mockFetch } from './helpers/mock-fetch.js';

describe('RemoteRepoSource Tree Indexer', () => {
  const treePayload = {
    sha: 'abcd1234ef567890',
    truncated: false,
    tree: [
      { path: 'README.md', type: 'blob', size: 1200 },
      { path: 'src/main.ts', type: 'blob', size: 4500 },
      { path: 'src/api/auth.ts', type: 'blob', size: 3100 },
      { path: 'package.json', type: 'blob', size: 800 },
      { path: '.claude/skills/audit/SKILL.md', type: 'blob', size: 1500 },
      { path: 'dist/bundle.js', type: 'blob', size: 90000 },
    ],
  };

  it('fetches repo tree, pins commit SHA, and generates scored file descriptors', async () => {
    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/owner/repo/git/trees/main', body: treePayload },
      { match: 'raw.githubusercontent.com/owner/repo/abcd1234ef567890/README.md', body: '# Security Repo\nAuthentication service.' },
    ]);

    const source = new RemoteRepoSource({ fetchImpl, token: 'test-token' });
    const index = await source.indexTree('owner', 'repo', 'main');

    expect(index.success).toBe(true);
    expect(index.commitSha).toBe('abcd1234ef567890');
    expect(index.descriptors.length).toBeGreaterThanOrEqual(5);

    const mainDesc = index.descriptors.find(d => d.path === 'src/main.ts');
    expect(mainDesc).toBeDefined();
    expect(mainDesc?.isSource).toBe(true);
    expect(mainDesc?.importanceScore).toBeGreaterThan(50);
  });

  it('shortlists top candidate files matching an investigation query without downloading all files', async () => {
    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/owner/repo/git/trees/main', body: treePayload },
      { match: 'raw.githubusercontent.com/owner/repo/abcd1234ef567890/README.md', body: '# Auth Service' },
    ]);

    const source = new RemoteRepoSource({ fetchImpl });
    const shortlist = await source.shortlistFiles('owner', 'repo', 'main', {
      query: 'authentication token jwt',
      limit: 3,
    });

    expect(shortlist.length).toBeLessThanOrEqual(3);
    expect(shortlist.some(s => s.path.includes('auth.ts') || s.path.includes('main.ts'))).toBe(true);
  });

  it('safely fetches raw content at pinned commit SHA with size limit guard', async () => {
    const { fetchImpl } = mockFetch([
      { match: 'raw.githubusercontent.com/owner/repo/pinned-sha/src/api/auth.ts', body: 'export function verifyJwt() {}' },
    ]);

    const source = new RemoteRepoSource({ fetchImpl });
    const content = await source.fetchRawFile('owner', 'repo', 'pinned-sha', 'src/api/auth.ts', 10000);

    expect(content.ok).toBe(true);
    expect(content.text).toBe('export function verifyJwt() {}');
  });

  it('rejects path traversal attempts', async () => {
    const source = new RemoteRepoSource();

    const res1 = await source.fetchRawFile('owner', 'repo', 'pinned-sha', '../secret');
    expect(res1.ok).toBe(false);
    expect(res1.error).toBe('Path traversal or absolute path rejected');

    const res2 = await source.fetchRawFile('owner', 'repo', 'pinned-sha', '../../etc/passwd');
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe('Path traversal or absolute path rejected');

    const res3 = await source.fetchRawFile('owner', 'repo', 'pinned-sha', '/etc/passwd');
    expect(res3.ok).toBe(false);
    expect(res3.error).toBe('Path traversal or absolute path rejected');

    const res4 = await source.fetchRawFile('owner', 'repo', 'pinned-sha', '');
    expect(res4.ok).toBe(false);
    expect(res4.error).toBe('Path traversal or absolute path rejected');
  });

  it('query matching strictly prioritizes token matches over high-scoring irrelevant files', async () => {
    const customTree = {
      sha: 'test-sha',
      tree: [
        { path: 'src/main.ts', type: 'blob', size: 1000 },
        { path: 'docs/telemetry.txt', type: 'blob', size: 500 },
      ],
    };
    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/owner/repo/git/trees/main', body: customTree },
    ]);

    const source = new RemoteRepoSource({ fetchImpl });
    const shortlist = await source.shortlistFiles('owner', 'repo', 'main', {
      query: 'telemetry',
      limit: 1,
    });

    expect(shortlist).toHaveLength(1);
    expect(shortlist[0].path).toBe('docs/telemetry.txt');
  });

  it('handles 429 rate limit properly', async () => {
    const { fetchImpl } = mockFetch([
      {
        match: 'api.github.com/repos/owner/repo/git/trees/main',
        status: 429,
        body: { message: 'API rate limit exceeded' },
      },
    ]);

    const source = new RemoteRepoSource({ fetchImpl });
    const res = await source.indexTree('owner', 'repo', 'main');

    expect(res.success).toBe(false);
    expect(res.error).toBe('GitHub API rate limit exceeded during tree retrieval.');
  });
});
