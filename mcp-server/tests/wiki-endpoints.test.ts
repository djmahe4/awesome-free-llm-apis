import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { createExpressApp } from '../src/server.js';
import {
  issueLeaseForTests,
  resetLeaseState,
  toB64Url,
  LEASE_HEADER,
  NONCE_HEADER,
  MAC_HEADER,
  computeMac,
} from '../src/wiki-lease.js';

type Lease = { leaseId: string; exp: number; sharedSecret: Buffer };

describe('/api/wiki/* hybrid post-quantum lease endpoints', () => {
  let app: ReturnType<typeof createExpressApp>;
  let server: Server;
  let baseUrl: string;
  let workspaceDir: string;

  beforeEach(async () => {
    resetLeaseState({ rotateKeys: true });
    workspaceDir = path.join(os.tmpdir(), `wiki-lease-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(workspaceDir, { recursive: true });
    app = createExpressApp();
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    server?.close();
    try {
      await fsp.rm(workspaceDir, { recursive: true, force: true });
    } catch {}
  });

  const mintLease = (): Lease => {
    const { params, sharedSecret } = issueLeaseForTests();
    return { leaseId: params.leaseId, exp: params.exp, sharedSecret };
  };

  const headersFor = (method: string, route: string, lease: Lease, nonceOverride?: string) => {
    const nonce = nonceOverride ?? crypto.randomBytes(16).toString('base64url');
    const mac = computeMac(lease.sharedSecret, nonce, lease.exp, method, route);
    return {
      [LEASE_HEADER]: lease.leaseId,
      [NONCE_HEADER]: nonce,
      [MAC_HEADER]: mac,
    } as Record<string, string>;
  };

  const wsQuery = (extra = '') =>
    `workspace_root=${encodeURIComponent(workspaceDir)}${extra ? `&${extra}` : ''}`;

  it('issues the lease module to same-origin dashboard fetches', async () => {
    const kemPub = toB64Url(ml_kem768.keygen().publicKey);
    const xPub = toB64Url(x25519.keygen().publicKey);
    const res = await fetch(`${baseUrl}/api/wiki/lease.mjs?kem=${kemPub}&x=${xPub}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    expect(body).toContain("import { finishLease } from '/wiki-lease-client.js'");
    expect(body).toContain('export const params');
    expect(body).toContain('export async function finish');
  });

  it('rejects lease issuance without Sec-Fetch-Site (403) and cross-origin (403)', async () => {
    const kemPub = toB64Url(ml_kem768.keygen().publicKey);
    const xPub = toB64Url(x25519.keygen().publicKey);
    const url = `${baseUrl}/api/wiki/lease.mjs?kem=${kemPub}&x=${xPub}`;

    const bare = await fetch(url);
    expect(bare.status).toBe(403);
    expect((await bare.json()).ok).toBe(false);

    const crossOrigin = await fetch(url, {
      headers: { 'sec-fetch-site': 'same-origin', origin: 'http://evil.test' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('hard-401s data routes without a lease', async () => {
    const res = await fetch(`${baseUrl}/api/wiki/pages?${wsQuery()}`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('lease required');
  });

  it('accepts a valid lease MAC and rejects tampering, unknown leases, and replayed nonces', async () => {
    const lease = mintLease();

    const ok = await fetch(`${baseUrl}/api/wiki/pages?${wsQuery()}`, {
      headers: headersFor('GET', `/api/wiki/pages?${wsQuery()}`, lease),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.result.pages)).toBe(true);

    const nonce = crypto.randomBytes(16).toString('base64url');
    const badMac = await fetch(`${baseUrl}/api/wiki/pages?${wsQuery()}`, {
      headers: { ...headersFor('GET', `/api/wiki/pages?${wsQuery()}`, lease, nonce), [MAC_HEADER]: '00'.repeat(32) },
    });
    expect(badMac.status).toBe(401);
    expect((await badMac.json()).error).toBe('invalid lease mac');

    const unknown = await fetch(`${baseUrl}/api/wiki/pages?${wsQuery()}`, {
      headers: { ...headersFor('GET', `/api/wiki/pages?${wsQuery()}`, lease), [LEASE_HEADER]: 'not-a-real-lease' },
    });
    expect(unknown.status).toBe(401);

    const replayNonce = 'replay-nonce-' + Date.now();
    const first = await fetch(`${baseUrl}/api/wiki/pages?${wsQuery()}`, {
      headers: headersFor('GET', `/api/wiki/pages?${wsQuery()}`, lease, replayNonce),
    });
    expect(first.status).toBe(200);
    const replay = await fetch(`${baseUrl}/api/wiki/pages?${wsQuery()}`, {
      headers: headersFor('GET', `/api/wiki/pages?${wsQuery()}`, lease, replayNonce),
    });
    expect(replay.status).toBe(401);
    expect((await replay.json()).error).toBe('nonce already used');
  });

  it('maps missing workspace to 400 and missing fields to 400', async () => {
    const lease = mintLease();
    const badWs = await fetch(`${baseUrl}/api/wiki/pages?workspace_root=${encodeURIComponent('/definitely/not/a/dir')}`, {
      headers: headersFor('GET', `/api/wiki/pages?workspace_root=${encodeURIComponent('/definitely/not/a/dir')}`, lease),
    });
    expect(badWs.status).toBe(400);

    const noTitle = await fetch(`${baseUrl}/api/wiki/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headersFor('POST', '/api/wiki/page', lease) },
      body: JSON.stringify({ content: 'no title here' }),
    });
    expect(noTitle.status).toBe(400);
    expect((await noTitle.json()).error).toContain('title');
  });

  it('round-trips wiki write -> read -> batch list with content', async () => {
    const lease = mintLease();
    const title = 'Lease Roundtrip Page';
    // Pages are hard-capped at wikiConfig.maxPageSizeBytes (8KB) — use a
    // large-but-legal page so frontmatter + content stays under the cap.
    const content = 'Hello from the lease.\n# Heading\nsearchable-unique-token-abc123\n' + 'x'.repeat(7_500);

    const write = await fetch(`${baseUrl}/api/wiki/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headersFor('POST', '/api/wiki/page', lease) },
      body: JSON.stringify({ title, content, tags: [], links: [], workspace_root: workspaceDir }),
    });
    expect(write.status).toBe(200);
    expect((await write.json()).ok).toBe(true);

    const readRoute = `/api/wiki/page?${wsQuery(`title=${encodeURIComponent(title)}`)}`;
    const read = await fetch(`${baseUrl}${readRoute}`, { headers: headersFor('GET', readRoute, lease) });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.result.page.title).toBe(title);
    expect(readBody.result.page.content).toBe(content);

    const listRoute = `/api/wiki/pages?${wsQuery('include=content')}`;
    const list = await fetch(`${baseUrl}${listRoute}`, { headers: headersFor('GET', listRoute, lease) });
    expect(list.status).toBe(200);
    const pages = (await list.json()).result.pages;
    expect(pages.length).toBe(1);
    expect(pages[0].content).toBe(content);

    const searchRoute = `/api/wiki/search?${wsQuery(`query=${encodeURIComponent('searchable-unique-token-abc123')}`)}`;
    const search = await fetch(`${baseUrl}${searchRoute}`, { headers: headersFor('GET', searchRoute, lease) });
    expect(search.status).toBe(200);
    expect(Array.isArray((await search.json()).result.results)).toBe(true);
  });

  it('serves a large wiki (60 pages x ~7.5KB) via one batch request without 413 or rate-limit errors', async () => {
    const lease = mintLease();
    const pageCount = 60;
    // Near the 8KB page cap (frontmatter included) — largest legal pages.
    const filler = 'y'.repeat(7_500);

    const startedWrites = Date.now();
    for (let i = 0; i < pageCount; i++) {
      const route = '/api/wiki/page';
      const res = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headersFor('POST', route, lease) },
        body: JSON.stringify({ title: `Bulk Page ${i}`, content: `marker-${i} ${filler}`, tags: [], links: [], workspace_root: workspaceDir }),
      });
      expect(res.status).toBe(200);
    }
    const writeMs = Date.now() - startedWrites;

    const listRoute = `/api/wiki/pages?${wsQuery('include=content')}`;
    const startedList = Date.now();
    const list = await fetch(`${baseUrl}${listRoute}`, { headers: headersFor('GET', listRoute, lease) });
    const listMs = Date.now() - startedList;

    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.ok).toBe(true);
    expect(body.result.pages.length).toBe(pageCount);
    const totalBytes = body.result.pages.reduce((sum: number, p: any) => sum + (p.content?.length ?? 0), 0);
    expect(totalBytes).toBeGreaterThanOrEqual(pageCount * 7_000);

    // Single batch round trip must stay far below any user-facing latency
    // threshold; the old per-title fan-out was 60 requests.
    expect(listMs).toBeLessThan(10_000);
    expect(writeMs).toBeLessThan(120_000);
  }, 150_000);

  it('accepts a near-2MB JSON body without 413 and maps oversized wiki content to 400', async () => {
    const lease = mintLease();
    // Body is ~1.5MB (under the 2mb /api/wiki/page JSON limit) but the wiki
    // page cap is 8KB — must reach the app and fail as validation (400),
    // never as a 413 payload rejection.
    const huge = 'z'.repeat(1_500_000);
    const res = await fetch(`${baseUrl}/api/wiki/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headersFor('POST', '/api/wiki/page', lease) },
      body: JSON.stringify({ title: 'Too Big', content: huge, tags: [], links: [], workspace_root: workspaceDir }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('exceeds maximum size');
  });
});
