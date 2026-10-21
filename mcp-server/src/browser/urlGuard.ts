import { checkPublicHttpUrl, type UrlCheck } from '../utils/ssrf-guard.js';

let resolverOverride: ((host: string) => Promise<string[]>) | null = null;

/** Tests only: replaces DNS so no test performs a real lookup. */
export function setBrowserUrlResolverForTesting(resolve: ((host: string) => Promise<string[]>) | null): void {
    resolverOverride = resolve;
}

/**
 * Gate for every URL browser_tool is asked to open or replay: http(s) only, no credentials, and
 * no private/loopback/link-local targets unless listed in BROWSER_ALLOW_HOSTS (comma-separated
 * `host` or `host:port`, e.g. `localhost:3111`) or BROWSER_ALLOW_PRIVATE=1 (everything private).
 * Cloud metadata addresses are never allowed.
 */
export function checkBrowserUrl(url: string): Promise<UrlCheck> {
    return checkPublicHttpUrl(url, {
        allowPrivate: process.env.BROWSER_ALLOW_PRIVATE === '1',
        allowHosts: (process.env.BROWSER_ALLOW_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean),
        resolve: resolverOverride ?? undefined,
    });
}
