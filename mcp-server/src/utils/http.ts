import nodeFetch from 'node-fetch';
import https from 'node:https';
import http from 'node:http';

/**
 * Small, dependency-free JSON GET used by the Docker Hub / apt grounding clients.
 *
 * Two findings drove its shape (both measured, not assumed):
 *  - Connect behaviour: on a network where one address family is dead (this dev box's
 *    IPv6 route to sources.debian.org), Node's default agent hangs until the timeout on
 *    EVERY call while curl works. An agent with `autoSelectFamily` + a short per-attempt
 *    timeout falls back to the working family in <1s, so every request goes through one.
 *  - Rate limits: Docker Hub documents per-minute limits with X-RateLimit-* headers and a
 *    429 + Retry-After; GitLab sends RateLimit-* . Both are parsed, and a 429 is retried
 *    only if the server's own wait fits inside `maxWaitMs`, otherwise it is surfaced to
 *    the caller (never hammered, never hidden).
 *
 * Never throws: network failure is `status: 0` + `error`, so callers can report
 * "not found / unavailable" honestly instead of crashing a whole lookup.
 */

export const USER_AGENT = 'free-llm-mcp/1.0 (+tool-grounding; https://github.com/)';

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Unix epoch seconds at which the window resets (when the server told us). */
  resetAtEpochS?: number;
}

export interface HttpResult<T = any> {
  url: string;
  /** HTTP status, or 0 when no response was received (DNS/connect/timeout). */
  status: number;
  ok: boolean;
  json?: T;
  /** First chars of a non-JSON body, for diagnostics only. */
  textSnippet?: string;
  /** Full body (capped) — only populated by httpGetText. */
  text?: string;
  rateLimit?: RateLimitInfo;
  /** Set on 429 when the server asked us to wait longer than we were willing to. */
  retryAfterMs?: number;
  error?: string;
  attempts: number;
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; agent?: unknown }) => Promise<FetchResponseLike>;

export interface HttpOptions {
  timeoutMs?: number;
  /** Extra attempts after the first (network error, 5xx, 429 within maxWaitMs). */
  retries?: number;
  backoffMs?: number;
  /** Longest single wait we will sit through for a 429 / backoff. */
  maxWaitMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const httpsAgent = new https.Agent({ keepAlive: false, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500 } as https.AgentOptions);
const httpAgent = new http.Agent({ keepAlive: false, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500 } as http.AgentOptions);

const defaultFetch: FetchLike = (url, init) =>
  nodeFetch(url, { ...init, agent: (parsed: URL) => (parsed.protocol === 'http:' ? httpAgent : httpsAgent) } as any) as unknown as Promise<FetchResponseLike>;

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const num = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Reads both Docker Hub style (X-RateLimit-*) and GitLab/IETF style (RateLimit-*) headers. */
export function parseRateLimit(h: { get(name: string): string | null }, nowMs: number): RateLimitInfo | undefined {
  const limit = num(h.get('x-ratelimit-limit')) ?? num(h.get('ratelimit-limit'));
  const remaining = num(h.get('x-ratelimit-remaining')) ?? num(h.get('ratelimit-remaining'));
  const reset = num(h.get('x-ratelimit-reset')) ?? num(h.get('ratelimit-reset'));
  if (limit === undefined && remaining === undefined && reset === undefined) return undefined;
  // `reset` is an epoch in both documented variants; tolerate a relative-seconds value too.
  const resetAtEpochS = reset === undefined ? undefined : (reset > 1e9 ? reset : Math.round(nowMs / 1000) + reset);
  return { limit, remaining, resetAtEpochS };
}

/** Retry-After may be delta-seconds or an HTTP date. */
function retryAfterMs(h: { get(name: string): string | null }, nowMs: number): number | undefined {
  const raw = h.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - nowMs) : undefined;
}

function describeNetworkError(e: any, timeoutMs: number): string {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `timeout after ${timeoutMs}ms`;
  const code = e?.code ?? e?.cause?.code ?? e?.errno;
  return `${e?.message || String(e)}${code ? ` [${code}]` : ''}`;
}

const MAX_TEXT_BYTES = 512 * 1024;
/** A JSON body larger than this is not parsed: a single hostile or broken endpoint must not fill memory with one object. */
const MAX_JSON_BYTES = 5 * 1024 * 1024;

/** GitHub signals its limits with 403 (quota: remaining 0, or a message; secondary limit: Retry-After), not only 429. */
function isRateLimit403(status: number, rateLimit: RateLimitInfo | undefined, h: { get(name: string): string | null }, body: string): boolean {
  if (status !== 403) return false;
  return rateLimit?.remaining === 0 || h.get('retry-after') !== null || /rate limit/i.test(body.slice(0, 300));
}

async function httpRequest<T>(url: string, opts: HttpOptions, captureText: boolean): Promise<HttpResult<T>> {
  const {
    timeoutMs = 15_000, retries = 2, backoffMs = 500, maxWaitMs = 10_000,
    fetchImpl = defaultFetch, sleep = defaultSleep, now = Date.now,
  } = opts;
  const headers = { 'User-Agent': USER_AGENT, Accept: captureText ? 'text/plain, text/markdown, */*' : 'application/json', ...opts.headers };

  let last: HttpResult<T> | undefined;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let result: HttpResult<T>;
    let serverWaitMs: number | undefined;
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.text();
      const t = now();
      result = { url, status: res.status, ok: res.status >= 200 && res.status < 300, attempts: attempt, rateLimit: parseRateLimit(res.headers, t) };
      if (captureText) {
        result.text = body.slice(0, MAX_TEXT_BYTES);
      } else if (body.length > MAX_JSON_BYTES) {
        result.ok = false;
        result.error = `response body too large (${body.length} characters, limit ${MAX_JSON_BYTES})`;
        result.textSnippet = body.slice(0, 200);
      } else {
        try { result.json = JSON.parse(body) as T; }
        catch { result.textSnippet = body.slice(0, 200); }
      }
      if (res.status === 429 || isRateLimit403(res.status, result.rateLimit, res.headers, body)) {
        serverWaitMs = retryAfterMs(res.headers, t)
          ?? (result.rateLimit?.resetAtEpochS !== undefined ? Math.max(0, result.rateLimit.resetAtEpochS * 1000 - t) : undefined);
        if (serverWaitMs !== undefined) result.retryAfterMs = serverWaitMs;
      }
    } catch (e: any) {
      result = { url, status: 0, ok: false, error: describeNetworkError(e, timeoutMs), attempts: attempt };
    }
    last = result;

    const limited = result.status === 429 || (result.status === 403 && result.retryAfterMs !== undefined);
    const retryable = result.status === 0 || limited || (result.status >= 500 && result.status !== 501);
    if (!retryable || attempt > retries) return result;

    let wait = backoffMs * 2 ** (attempt - 1);
    if (limited) {
      wait = serverWaitMs ?? wait;
      if (wait > maxWaitMs) return result; // the server wants longer than we will wait: surface it, don't hammer
    }
    await sleep(Math.min(wait, maxWaitMs));
  }
  return last!;
}

export function httpGetJson<T = any>(url: string, opts: HttpOptions = {}): Promise<HttpResult<T>> {
  return httpRequest<T>(url, opts, false);
}

/** Same retry/timeout/rate-limit behaviour, but returns the raw body (e.g. a README or debian/control). */
export function httpGetText(url: string, opts: HttpOptions = {}): Promise<HttpResult<never>> {
  return httpRequest<never>(url, opts, true);
}
