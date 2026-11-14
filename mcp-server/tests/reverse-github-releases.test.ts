import { describe, it, expect } from 'vitest';
import { listReleaseAssets, classifyAsset, type GitHubReleaseAsset } from '../src/reverse/github-releases.js';
import { mockFetch } from './helpers/mock-fetch.js';

describe('GitHub Release Asset Discovery & Classifier', () => {
  it('classifies assets into target categories accurately', () => {
    expect(classifyAsset('app.asar', 'application/octet-stream')).toBe('asar');
    expect(classifyAsset('firmware.bin', 'application/octet-stream')).toBe('firmware');
    expect(classifyAsset('model-q4_k_m.gguf', 'application/octet-stream')).toBe('ai_model');
    expect(classifyAsset('binary-linux-x64', 'application/octet-stream')).toBe('binary_native');
    expect(classifyAsset('service.exe', 'application/x-msdownload')).toBe('binary_native');
    expect(classifyAsset('libcore.so', 'application/octet-stream')).toBe('binary_native');
    expect(classifyAsset('dist.zip', 'application/zip')).toBe('archive');
    expect(classifyAsset('app-linux-x64.tar.xz', 'application/x-xz')).toBe('archive');
    expect(classifyAsset('installer.deb', 'application/vnd.debian.binary-package')).toBe('installer');
    expect(classifyAsset('notes.txt', 'text/plain')).toBe('document');
    expect(classifyAsset('app-linux-x64.sha256', 'text/plain')).toBe('document');
  });

  it('fetches latest releases and extracts classified assets', async () => {
    const mockRelease = [
      {
        id: 101,
        tag_name: 'v1.0.0',
        name: 'Release v1.0.0',
        published_at: '2026-11-01T12:00:00Z',
        assets: [
          {
            id: 201,
            name: 'crackme.elf',
            size: 1048576,
            content_type: 'application/octet-stream',
            browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/crackme.elf',
          },
          {
            id: 202,
            name: 'payload.asar',
            size: 2097152,
            content_type: 'application/octet-stream',
            browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/payload.asar',
          },
        ],
      },
    ];

    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/owner/repo/releases', body: mockRelease },
    ]);

    const result = await listReleaseAssets('owner', 'repo', { fetchImpl, token: 'mock-token' });
    expect(result.success).toBe(true);
    expect(result.releases).toHaveLength(1);
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0].category).toBe('binary_native');
    expect(result.assets[0].candidateForAnalyzeArtifact).toBe(true);
    expect(result.assets[1].category).toBe('asar');
    expect(result.assets[1].candidateForAnalyzeArtifact).toBe(true);
  });

  it('handles rate limits gracefully with informative error message', async () => {
    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/owner/repo/releases', status: 403, body: { message: 'API rate limit exceeded' } },
    ]);

    const result = await listReleaseAssets('owner', 'repo', { fetchImpl });
    expect(result.success).toBe(false);
    expect(result.error).toContain('rate limit');
  });
});
