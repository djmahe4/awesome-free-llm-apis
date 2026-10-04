// Hybrid post-quantum wiki lease client — runs in the browser (via the
// import map in index.html) and in Node. Talks to src/wiki-lease.ts.
//
// Handshake (once per lease): ML-KEM-768 + X25519 -> HKDF-SHA256 shared
// secret; ML-DSA-65 + Ed25519 signatures over the handshake transcript.
// Per request: HMAC-SHA256 of `method|path|nonce|exp` keyed by the shared
// secret, fresh single-use nonce, 60s TTL.

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

const encoder = new TextEncoder();

export const LEASE_TTL_MS = 60_000;
const HKDF_INFO = 'wiki-lease-v1';
const REHANDSHAKE_MARGIN_MS = 15_000;

export function toB64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(value) {
  const norm = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Client half of the handshake: fresh ML-KEM-768 + X25519 key pairs. */
export async function generateLeaseSecrets() {
  return {
    kem: ml_kem768.keygen(), // { publicKey, secretKey }
    x: x25519.keygen(), // { publicKey, secretKey }
  };
}

export class WikiLease {
  constructor(leaseId, sharedSecret, exp) {
    this.leaseId = leaseId;
    this.sharedSecret = sharedSecret;
    this.exp = exp;
  }

  remainingMs() {
    return this.exp - Date.now();
  }

  /** Request headers for `method` + `path` (path must include the query
   *  string exactly as sent — the server MACs `req.originalUrl`). */
  headers(method, path) {
    const nonce = toB64Url(randomBytes(16));
    const message = `${method}|${path}|${nonce}|${this.exp}`;
    const mac = toHex(hmac(sha256, this.sharedSecret, encoder.encode(message)));
    return {
      'x-wiki-lease': this.leaseId,
      'x-wiki-nonce': nonce,
      'x-wiki-mac': mac,
    };
  }

  /** fetch() wrapper that attaches lease headers automatically. */
  async fetchWith(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const base = globalThis.location ? globalThis.location.origin : 'http://localhost';
    const parsed = new URL(url, base);
    const path = parsed.pathname + parsed.search;
    const method = (init.method ?? 'GET').toUpperCase();
    return fetch(url, {
      ...init,
      method,
      headers: { ...(init.headers ?? {}), ...this.headers(method, path) },
    });
  }
}

/**
 * Turn handshake params (from GET /api/wiki/lease.mjs) + this client's
 * secrets into a live lease. Verifies both signatures over a recomputed
 * transcript before trusting the shared secret.
 */
export async function finishLease(params, clientSecrets) {
  const kemShared = ml_kem768.decapsulate(
    fromB64Url(params.cipherText),
    clientSecrets.kem.secretKey
  );
  const dh = x25519.getSharedSecret(
    clientSecrets.x.secretKey,
    fromB64Url(params.serverX)
  );
  const sharedSecret = hkdf(
    sha256,
    concat(kemShared, dh),
    encoder.encode(params.nonce),
    encoder.encode(HKDF_INFO),
    32
  );

  const transcript = [
    HKDF_INFO,
    params.nonce,
    String(params.exp),
    toB64Url(clientSecrets.kem.publicKey),
    toB64Url(clientSecrets.x.publicKey),
    params.cipherText,
    params.serverX,
    params.serverDsaPk,
    params.serverEdPk,
  ].join('|');
  if (transcript !== params.transcript) {
    throw new Error('wiki lease: handshake transcript mismatch');
  }

  const msg = encoder.encode(transcript);
  const dsaOk = ml_dsa65.verify(fromB64Url(params.sigDsa), msg, fromB64Url(params.serverDsaPk));
  let edOk = false;
  try {
    edOk = ed25519.verify(fromB64Url(params.sigEd), msg, fromB64Url(params.serverEdPk));
  } catch {
    edOk = false;
  }
  if (!dsaOk || !edOk) {
    throw new Error('wiki lease: handshake signature verification failed');
  }
  return new WikiLease(params.leaseId, sharedSecret, params.exp);
}

let currentLease = null;

/**
 * Acquire (or reuse) the dashboard lease:
 *   generateLeaseSecrets() -> dynamic import of the server-rendered
 *   /api/wiki/lease.mjs -> finish(). Re-handshakes when <15s remain.
 */
export async function acquireWikiLease(options = {}) {
  const force = options.force === true;
  if (!force && currentLease && currentLease.remainingMs() > REHANDSHAKE_MARGIN_MS) {
    return currentLease;
  }
  const secrets = await generateLeaseSecrets();
  // `t` busts the browser module cache so a re-handshake gets fresh params.
  const url =
    `/api/wiki/lease.mjs?kem=${toB64Url(secrets.kem.publicKey)}` +
    `&x=${toB64Url(secrets.x.publicKey)}&t=${Date.now()}`;
  const mod = await import(url);
  const finish = typeof mod.finish === 'function' ? mod.finish : mod.default;
  if (typeof finish !== 'function') {
    throw new Error('wiki lease: lease module has no finish() export');
  }
  currentLease = await finish(secrets);
  return currentLease;
}

export function currentWikiLease() {
  return currentLease;
}

export function clearWikiLease() {
  currentLease = null;
}

/** Lease headers without managing the lease yourself (acquires on demand). */
export async function wikiLeaseHeaders(method, path) {
  const lease = await acquireWikiLease();
  return lease.headers(method, path);
}
