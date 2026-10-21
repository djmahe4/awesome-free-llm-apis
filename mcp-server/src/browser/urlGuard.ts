import { checkPublicHttpUrl, type UrlCheck } from '../utils/ssrf-guard.js';

let resolverOverride: ((host: string) => Promise<string[]>) | null = null;

/** Tests only: replaces DNS so no test performs a real lookup. */
export function setBrowserUrlResolverForTesting(resolve: ((host: string) => Promise<string[]>) | null): void {
    resolverOverride = resolve;
}

/**
 * Gate for every URL browser_tool is asked to open or replay: http(s) only, no credentials, and
 * no private/loopback/link-local/metadata targets unless BROWSER_ALLOW_PRIVATE=1 (local dev).
 */
export function checkBrowserUrl(url: string): Promise<UrlCheck> {
    return checkPublicHttpUrl(url, {
        allowPrivate: process.env.BROWSER_ALLOW_PRIVATE === '1',
        resolve: resolverOverride ?? undefined,
    });
}
