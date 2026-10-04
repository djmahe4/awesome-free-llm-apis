// Hybrid post-quantum lease layer for the /api/wiki/* surface.
//
// Handshake (once per lease, ~10ms server / ~3ms client):
//   ML-KEM-768 + X25519 -> HKDF-SHA256 shared secret
//   ML-DSA-65  + Ed25519 -> signatures over the handshake transcript
// Requests (hot path): HMAC-SHA256 of `method|path|nonce|exp` keyed by the
// shared secret (~0.01ms), single-use nonce (replay cache), 60s TTL.
//
// The lease is issued as dynamically rendered ESM from GET /api/wiki/lease.mjs
// so only a client that executes server-generated JS (the dashboard) can turn
// the handshake params into request headers.

import crypto from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export const LEASE_TTL_MS = 60_000;
export const LEASE_HEADER = 'x-wiki-lease';
export const NONCE_HEADER = 'x-wiki-nonce';
export const MAC_HEADER = 'x-wiki-mac';

const HKDF_INFO = 'wiki-lease-v1';
const TRANSCRIPT_VERSION = 'wiki-lease-v1';
const KEM_PK_BYTES = 1184; // ML-KEM-768
const X25519_PK_BYTES = 32;
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const encoder = new TextEncoder();

export class LeaseError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) {
        super(message);
        this.name = 'LeaseError';
        this.status = status;
    }
}

export function toB64Url(bytes: Uint8Array | Buffer): string {
    return Buffer.from(bytes).toString('base64url');
}

export function fromB64Url(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** Canonical MAC input — must match dashboard/wiki-lease-client.js byte for byte. */
export function macMessage(nonce: string, exp: number, method: string, path: string): string {
    return `${method}|${path}|${nonce}|${exp}`;
}

export function computeMac(sharedSecret: Buffer, nonce: string, exp: number, method: string, path: string): string {
    return crypto.createHmac('sha256', sharedSecret)
        .update(macMessage(nonce, exp, method, path))
        .digest('hex');
}

interface ServerKeys {
    dsa: { publicKey: Uint8Array; secretKey: Uint8Array };
    edPrivateKey: crypto.KeyObject;
    edPublicKeyRaw: Buffer;
    xPrivateKey: crypto.KeyObject;
    xPublicKeyRaw: Buffer;
}

let serverKeys: ServerKeys | null = null;

function getServerKeys(): ServerKeys {
    if (serverKeys) return serverKeys;
    const dsa = ml_dsa65.keygen();
    const ed = crypto.generateKeyPairSync('ed25519');
    const x = crypto.generateKeyPairSync('x25519');
    serverKeys = {
        dsa,
        edPrivateKey: ed.privateKey,
        edPublicKeyRaw: rawFromSpki(ed.publicKey),
        xPrivateKey: x.privateKey,
        xPublicKeyRaw: rawFromSpki(x.publicKey),
    };
    return serverKeys;
}

/** SPKI DER for X25519/Ed25519 ends with the raw 32-byte key. */
function rawFromSpki(publicKey: crypto.KeyObject): Buffer {
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    return der.subarray(der.length - 32);
}

function publicKeyFromRawX25519(raw: Uint8Array): crypto.KeyObject {
    return crypto.createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
        format: 'der',
        type: 'spki',
    });
}

interface Lease {
    sharedSecret: Buffer;
    exp: number;
    nonces: LRUCache<string, true>;
}

const leases = new LRUCache<LeaseId, Lease>({ max: 500, ttl: LEASE_TTL_MS + 5_000 });
type LeaseId = string;

export interface HandshakeParams {
    leaseId: string;
    nonce: string;
    exp: number;
    cipherText: string;
    serverX: string;
    serverDsaPk: string;
    serverEdPk: string;
    sigDsa: string;
    sigEd: string;
    transcript: string;
}

export interface HandshakeInput {
    /** base64url ML-KEM-768 client public key (1184 bytes) */
    kemPub: string;
    /** base64url X25519 client public key (32 bytes) */
    xPub: string;
}

/** Run the hybrid handshake and mint a lease. Throws LeaseError on bad input. */
export function createHandshake(input: HandshakeInput): HandshakeParams {
    if (typeof input.kemPub !== 'string' || typeof input.xPub !== 'string') {
        throw new LeaseError('kem and x query params are required');
    }
    const clientKemPk = fromB64Url(input.kemPub);
    const clientXPk = fromB64Url(input.xPub);
    if (clientKemPk.length !== KEM_PK_BYTES) {
        throw new LeaseError(`kem public key must decode to ${KEM_PK_BYTES} bytes`);
    }
    if (clientXPk.length !== X25519_PK_BYTES) {
        throw new LeaseError(`x public key must decode to ${X25519_PK_BYTES} bytes`);
    }

    const keys = getServerKeys();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const exp = Date.now() + LEASE_TTL_MS;

    const { cipherText, sharedSecret: kemShared } = ml_kem768.encapsulate(clientKemPk);
    const dh = crypto.diffieHellman({
        privateKey: keys.xPrivateKey,
        publicKey: publicKeyFromRawX25519(clientXPk),
    });

    const sharedSecret = Buffer.from(
        crypto.hkdfSync('sha256', Buffer.concat([Buffer.from(kemShared), dh]), Buffer.from(nonce), HKDF_INFO, 32)
    );

    const transcript = [
        TRANSCRIPT_VERSION,
        nonce,
        String(exp),
        toB64Url(clientKemPk),
        toB64Url(clientXPk),
        toB64Url(cipherText),
        toB64Url(keys.xPublicKeyRaw),
        toB64Url(keys.dsa.publicKey),
        toB64Url(keys.edPublicKeyRaw),
    ].join('|');

    const sigDsa = ml_dsa65.sign(encoder.encode(transcript), keys.dsa.secretKey);
    const sigEd = crypto.sign(null, encoder.encode(transcript), keys.edPrivateKey);

    const leaseId = crypto.randomBytes(16).toString('base64url');
    leases.set(leaseId, {
        sharedSecret,
        exp,
        nonces: new LRUCache<string, true>({ max: 2_000 }),
    });

    return {
        leaseId,
        nonce,
        exp,
        cipherText: toB64Url(cipherText),
        serverX: toB64Url(keys.xPublicKeyRaw),
        serverDsaPk: toB64Url(keys.dsa.publicKey),
        serverEdPk: toB64Url(keys.edPublicKeyRaw),
        sigDsa: toB64Url(sigDsa),
        sigEd: toB64Url(sigEd),
        transcript,
    };
}

/**
 * Render the dynamically generated lease module. The client imports it, runs
 * its own half of the handshake (`finishLease` from /wiki-lease-client.js) and
 * gets back a `finish(clientSecrets)` entry point plus per-request headers.
 */
export function renderLeaseModule(params: HandshakeParams): string {
    const json = JSON.stringify(params);
    return [
        '// Dynamically rendered post-quantum wiki lease — generated per handshake.',
        "import { finishLease } from '/wiki-lease-client.js';",
        `export const params = ${json};`,
        'export async function finish(clientSecrets) {',
        '  return finishLease(params, clientSecrets);',
        '}',
        'export default finish;',
        ''
    ].join('\n');
}

function safeEqualHex(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function reject(res: import('express').Response, message: string, status = 401): void {
    res.status(status).json({ ok: false, error: message });
}

/**
 * Hard gate for /api/wiki/* — 401 unless the request carries a live lease
 * with a valid HMAC and a fresh (unreplayed) nonce.
 */
export function requireWikiLease(
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction
): void {
    const leaseId = req.get(LEASE_HEADER);
    const nonce = req.get(NONCE_HEADER);
    const mac = req.get(MAC_HEADER);
    if (!leaseId || !nonce || !mac) {
        reject(res, 'lease required');
        return;
    }
    const lease = leases.get(leaseId);
    if (!lease) {
        reject(res, 'lease unknown or expired');
        return;
    }
    if (Date.now() > lease.exp) {
        leases.delete(leaseId);
        reject(res, 'lease expired');
        return;
    }
    const expected = computeMac(lease.sharedSecret, nonce, lease.exp, req.method, req.originalUrl);
    if (!safeEqualHex(expected, mac)) {
        reject(res, 'invalid lease mac');
        return;
    }
    if (lease.nonces.has(nonce)) {
        reject(res, 'nonce already used');
        return;
    }
    lease.nonces.set(nonce, true);
    next();
}

/**
 * Anti-automation gate for the lease-rendering endpoint: only real browser
 * same-origin fetches (Sec-Fetch-Site) may obtain the handshake module.
 * Plain curl/HTTP clients without the header are rejected.
 */
export function assertDashboardFetch(
    req: import('express').Request,
    res: import('express').Response
): boolean {
    const site = req.get('sec-fetch-site');
    if (site !== 'same-origin' && site !== 'none') {
        reject(res, 'lease module is dashboard-only', 403);
        return false;
    }
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
        try {
            const originHost = new URL(origin).host;
            const host = req.get('host');
            if (host && originHost !== host) {
                reject(res, 'cross-origin lease requests are not allowed', 403);
                return false;
            }
        } catch {
            reject(res, 'invalid origin', 403);
            return false;
        }
    }
    return true;
}

/** Test helper: drop all issued leases (and optionally rotate server keys). */
export function resetLeaseState(options: { rotateKeys?: boolean } = {}): void {
    leases.clear();
    if (options.rotateKeys) serverKeys = null;
}

/** Test helper: mint a lease without the HTTP layer. */
export function issueLeaseForTests(): { params: HandshakeParams; sharedSecret: Buffer } {
    const clientKem = ml_kem768.keygen();
    const clientX = crypto.generateKeyPairSync('x25519');
    const params = createHandshake({
        kemPub: toB64Url(clientKem.publicKey),
        xPub: toB64Url(rawFromSpki(clientX.publicKey)),
    });
    const lease = leases.get(params.leaseId);
    if (!lease) throw new Error('lease was not stored');
    return { params, sharedSecret: lease.sharedSecret };
}
