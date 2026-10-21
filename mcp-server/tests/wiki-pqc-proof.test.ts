import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import {
  createHandshake,
  requireWikiLease,
  computeMac,
  macMessage,
  resetLeaseState,
  toB64Url,
  fromB64Url,
  LEASE_HEADER,
  NONCE_HEADER,
  MAC_HEADER,
  type HandshakeParams,
} from '../src/wiki-lease.js';

const encoder = new TextEncoder();
const HKDF_INFO = 'wiki-lease-v1';
const WALL_PATH = '/leasewall';

type ClientSecrets = { kem: { publicKey: Uint8Array; secretKey: Uint8Array }; x: { publicKey: Uint8Array; secretKey: Uint8Array } };

function newClientSecrets(): ClientSecrets {
  return { kem: ml_kem768.keygen(), x: x25519.keygen() };
}

function handshake(secrets: ClientSecrets): HandshakeParams {
  return createHandshake({
    kemPub: toB64Url(secrets.kem.publicKey),
    xPub: toB64Url(secrets.x.publicKey),
  });
}

/** Client half of the hybrid KEM+DH derivation — mirrors dashboard/wiki-lease-client.js `finishLease`. */
function deriveHybrid(params: HandshakeParams, secrets: ClientSecrets): Buffer {
  const kemShared = ml_kem768.decapsulate(fromB64Url(params.cipherText), secrets.kem.secretKey);
  const dh = x25519.getSharedSecret(secrets.x.secretKey, fromB64Url(params.serverX));
  const ikm = new Uint8Array(kemShared.length + dh.length);
  ikm.set(kemShared, 0);
  ikm.set(dh, kemShared.length);
  return Buffer.from(hkdf(sha256, ikm, encoder.encode(params.nonce), encoder.encode(HKDF_INFO), 32));
}

function deriveSingle(params: HandshakeParams, secrets: ClientSecrets, component: 'kem' | 'dh'): Buffer {
  const kemShared = ml_kem768.decapsulate(fromB64Url(params.cipherText), secrets.kem.secretKey);
  const dh = x25519.getSharedSecret(secrets.x.secretKey, fromB64Url(params.serverX));
  const ikm = component === 'kem' ? kemShared : dh;
  return Buffer.from(hkdf(sha256, ikm, encoder.encode(params.nonce), encoder.encode(HKDF_INFO), 32));
}

function recomputeTranscript(params: HandshakeParams, secrets: ClientSecrets): string {
  return [
    HKDF_INFO,
    params.nonce,
    String(params.exp),
    toB64Url(secrets.kem.publicKey),
    toB64Url(secrets.x.publicKey),
    params.cipherText,
    params.serverX,
    params.serverDsaPk,
    params.serverEdPk,
  ].join('|');
}

function safeVerify(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

function flipHexLastByte(b64url: string): string {
  const bytes = Buffer.from(fromB64Url(b64url));
  bytes[bytes.length - 1] ^= 0xff;
  return toB64Url(bytes);
}

function wallHeaders(secret: Buffer, leaseId: string, exp: number, method = 'POST', path = WALL_PATH): Record<string, string> {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const message = `${method}|${path}|${nonce}|${exp}`;
  const mac = Buffer.from(hmac(sha256, secret, encoder.encode(message))).toString('hex');
  return {
    [LEASE_HEADER]: leaseId,
    [NONCE_HEADER]: nonce,
    [MAC_HEADER]: mac,
  };
}

function postWall(baseUrl: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}${WALL_PATH}`, { method: 'POST', headers });
}

function errorOf(res: Response): Promise<{ error?: string }> {
  return res.json() as Promise<{ error?: string }>;
}

describe('hybrid post-quantum proof: ML-DSA-65 + Ed25519 signatures', () => {
  it('mints real ML-KEM-768/ML-DSA-65/X25519/Ed25519 material with FIPS/NIST sizes', () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);

    expect(fromB64Url(params.cipherText).length).toBe(1088); // ML-KEM-768 ciphertext
    expect(secrets.kem.publicKey.length).toBe(1184); // ML-KEM-768 public key
    expect(fromB64Url(params.serverDsaPk).length).toBe(1952); // ML-DSA-65 public key
    expect(fromB64Url(params.sigDsa).length).toBe(3309); // ML-DSA-65 signature (deterministic length)
    expect(fromB64Url(params.serverX).length).toBe(32); // X25519 public key
    expect(fromB64Url(params.serverEdPk).length).toBe(32); // Ed25519 public key
    expect(fromB64Url(params.sigEd).length).toBe(64); // Ed25519 signature
  });

  it('signatures verify independently against the recomputed transcript', () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const transcript = recomputeTranscript(params, secrets);
    expect(transcript).toBe(params.transcript);

    const msg = encoder.encode(transcript);
    expect(ml_dsa65.verify(fromB64Url(params.sigDsa), msg, fromB64Url(params.serverDsaPk))).toBe(true);
    expect(safeVerify(() => ed25519.verify(fromB64Url(params.sigEd), msg, fromB64Url(params.serverEdPk)))).toBe(true);
  });

  it('rejects tampered signatures and tampered transcripts', () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const msg = encoder.encode(params.transcript);

    expect(ml_dsa65.verify(fromB64Url(flipHexLastByte(params.sigDsa)), msg, fromB64Url(params.serverDsaPk))).toBe(false);
    expect(safeVerify(() => ed25519.verify(fromB64Url(flipHexLastByte(params.sigEd)), msg, fromB64Url(params.serverEdPk)))).toBe(false);

    const tampered = encoder.encode(params.transcript.replace(`|${params.nonce}|`, '|AAAAAAAAAAAAAAAAAAAAAA|'));
    expect(ml_dsa65.verify(fromB64Url(params.sigDsa), tampered, fromB64Url(params.serverDsaPk))).toBe(false);
    expect(safeVerify(() => ed25519.verify(fromB64Url(params.sigEd), tampered, fromB64Url(params.serverEdPk)))).toBe(false);
  });
});

describe('hybrid post-quantum proof: ML-KEM-768 + X25519 derivation', () => {
  it('client decapsulation + X25519 DH + HKDF reproduces a 32-byte secret', () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const secret = deriveHybrid(params, secrets);
    expect(secret.length).toBe(32);
    expect(secret.equals(deriveSingle(params, secrets, 'kem'))).toBe(false);
    expect(secret.equals(deriveSingle(params, secrets, 'dh'))).toBe(false);
  });

  it('noble HKDF matches node crypto.hkdfSync byte for byte (client ≡ server)', () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const kemShared = ml_kem768.decapsulate(fromB64Url(params.cipherText), secrets.kem.secretKey);
    const dh = x25519.getSharedSecret(secrets.x.secretKey, fromB64Url(params.serverX));
    const ikm = Buffer.concat([Buffer.from(kemShared), Buffer.from(dh)]);
    const nodeSecret = Buffer.from(
      crypto.hkdfSync('sha256', ikm, Buffer.from(params.nonce), HKDF_INFO, 32)
    );
    expect(deriveHybrid(params, secrets).equals(nodeSecret)).toBe(true);
  });
});

describe('hybrid post-quantum proof: requireWikiLease wall', () => {
  let app: ReturnType<typeof express>;
  let server: Server;
  let baseUrl: string;

  beforeEach(() => {
    resetLeaseState({ rotateKeys: true });
    app = express();
    app.post(WALL_PATH, requireWikiLease, (_req, res) => {
      res.json({ ok: true });
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server?.close();
  });

  it('accepts a lease with the full hybrid secret (200)', async () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const secret = deriveHybrid(params, secrets);
    const res = await postWall(baseUrl, wallHeaders(secret, params.leaseId, params.exp));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects a kem-only secret (401) — X25519 contribution is bound', async () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const kemOnly = deriveSingle(params, secrets, 'kem');
    const res = await postWall(baseUrl, wallHeaders(kemOnly, params.leaseId, params.exp));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe('invalid lease mac');
  });

  it('rejects a dh-only secret (401) — ML-KEM contribution is bound', async () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const dhOnly = deriveSingle(params, secrets, 'dh');
    const res = await postWall(baseUrl, wallHeaders(dhOnly, params.leaseId, params.exp));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe('invalid lease mac');
  });

  it('client HMAC (noble) is byte-identical to server computeMac (node crypto)', () => {
    const secret = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(16).toString('base64url');
    const exp = Date.now() + 60_000;
    const nobleMac = Buffer.from(hmac(sha256, secret, encoder.encode(macMessage(nonce, exp, 'POST', WALL_PATH)))).toString('hex');
    expect(nobleMac).toBe(computeMac(secret, nonce, exp, 'POST', WALL_PATH));
  });

  it('rejects a tampered MAC (401)', async () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const headers = wallHeaders(deriveHybrid(params, secrets), params.leaseId, params.exp);
    headers[MAC_HEADER] = headers[MAC_HEADER].replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    const res = await postWall(baseUrl, headers);
    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe('invalid lease mac');
  });

  it('rejects replayed nonces (401 on second use)', async () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const headers = wallHeaders(deriveHybrid(params, secrets), params.leaseId, params.exp);
    const first = await postWall(baseUrl, headers);
    expect(first.status).toBe(200);
    const replay = await postWall(baseUrl, headers);
    expect(replay.status).toBe(401);
    expect((await errorOf(replay)).error).toBe('nonce already used');
  });

  it('rejects missing lease headers (401)', async () => {
    const res = await postWall(baseUrl, {});
    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe('lease required');
  });

  it('rejects an unknown lease id (401)', async () => {
    const secrets = newClientSecrets();
    const params = handshake(secrets);
    const headers = wallHeaders(deriveHybrid(params, secrets), 'not-a-real-lease', params.exp);
    const res = await postWall(baseUrl, headers);
    expect(res.status).toBe(401);
    expect((await errorOf(res)).error).toBe('lease unknown or expired');
  });
});

describe('hybrid post-quantum proof: shipped dashboard client', () => {
  let app: ReturnType<typeof express>;
  let server: Server;
  let baseUrl: string;

  beforeEach(() => {
    resetLeaseState({ rotateKeys: true });
    app = express();
    app.post(WALL_PATH, requireWikiLease, (_req, res) => {
      res.json({ ok: true });
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server?.close();
  });

  it('dashboard/wiki-lease-client.js finishLease() derives the secret and passes the wall', async () => {
    const clientUrl = new URL('../dashboard/wiki-lease-client.js', import.meta.url).href;
    const client = (await import(/* @vite-ignore */ clientUrl)) as any;

    const secrets = await client.generateLeaseSecrets();
    const params = createHandshake({
      kemPub: client.toB64Url(secrets.kem.publicKey),
      xPub: client.toB64Url(secrets.x.publicKey),
    });

    const lease = await client.finishLease(params, secrets);
    expect(lease.leaseId).toBe(params.leaseId);
    expect(lease.sharedSecret.length).toBe(32);

    const res = await fetch(`${baseUrl}${WALL_PATH}`, {
      method: 'POST',
      headers: lease.headers('POST', WALL_PATH),
    });
    expect(res.status).toBe(200);
  });

  it('dashboard finishLease() refuses a tampered transcript', async () => {
    const clientUrl = new URL('../dashboard/wiki-lease-client.js', import.meta.url).href;
    const client = (await import(/* @vite-ignore */ clientUrl)) as any;

    const secrets = await client.generateLeaseSecrets();
    const params = createHandshake({
      kemPub: client.toB64Url(secrets.kem.publicKey),
      xPub: client.toB64Url(secrets.x.publicKey),
    });
    await expect(client.finishLease({ ...params, transcript: `${params.transcript}x` }, secrets)).rejects.toThrow(
      /transcript mismatch/
    );
  });

  it('dashboard finishLease() refuses a tampered signature', async () => {
    const clientUrl = new URL('../dashboard/wiki-lease-client.js', import.meta.url).href;
    const client = (await import(/* @vite-ignore */ clientUrl)) as any;

    const secrets = await client.generateLeaseSecrets();
    const params = createHandshake({
      kemPub: client.toB64Url(secrets.kem.publicKey),
      xPub: client.toB64Url(secrets.x.publicKey),
    });
    await expect(client.finishLease({ ...params, sigDsa: flipHexLastByte(params.sigDsa) }, secrets)).rejects.toThrow(
      /signature verification failed/
    );
  });
});
