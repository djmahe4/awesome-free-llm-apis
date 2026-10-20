import type { HttpResult } from './http.js';

/** Where a tool's context can come from. */
export type GroundingSource = 'github' | 'apt' | 'docker';

/**
 * Why a lookup produced nothing. `not_found` is a definitive "this source has no such
 * thing" (HTTP 404 / empty result set). The others mean we could NOT verify either way —
 * callers must not present them as "does not exist".
 */
export type NotFoundReason = 'not_found' | 'unverified' | 'rate_limited' | 'network_error' | 'invalid_input' | 'unexpected_response';

/** Something that shares the tool's name but cannot be tied to it — shown so a human can confirm, never asserted. */
export interface GroundingHint { label: string; url?: string; description?: string; why: string }

/**
 * `unverified` = candidates with the same NAME exist but none could be tied to the registered
 * tool (see groundingEvidence.ts). It is deliberately distinct from `not_found` (nothing
 * exists) so the caller can ask "did you mean ...?" instead of either guessing or denying.
 */
export type Lookup<T> =
  | { found: true; data: T; url: string }
  | { found: false; reason: NotFoundReason; detail: string; url?: string; retryAfterMs?: number; hints?: GroundingHint[] };

export function notFound(reason: NotFoundReason, detail: string, url?: string, retryAfterMs?: number, hints?: GroundingHint[]): Lookup<never> {
  return { found: false, reason, detail, url, retryAfterMs, ...(hints?.length ? { hints } : {}) };
}

/** Maps a non-success HTTP result to the honest Lookup failure for it. */
export function failFromHttp(res: HttpResult, what: string): Lookup<never> {
  if (res.status === 404) return notFound('not_found', `${what}: not found`, res.url);
  if (res.status === 429) return notFound('rate_limited', `${what}: rate limited${res.retryAfterMs !== undefined ? ` (retry in ${Math.ceil(res.retryAfterMs / 1000)}s)` : ''}`, res.url, res.retryAfterMs);
  if (res.status === 0) return notFound('network_error', `${what}: ${res.error ?? 'network error'}`, res.url);
  return notFound('unexpected_response', `${what}: HTTP ${res.status}${res.textSnippet ? ` — ${res.textSnippet.slice(0, 80)}` : ''}`, res.url);
}

/** Docker/Debian-style package and image names: lowercase alnum plus . _ + - (no path separators, no traversal). */
export const SAFE_NAME_RE = /^[a-z0-9][a-z0-9._+-]{0,254}$/;
