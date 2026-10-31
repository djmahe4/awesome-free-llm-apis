import { checkPublicHttpUrl, type UrlCheck } from '../utils/ssrf-guard.js';

let resolverOverride: ((host: string) => Promise<string[]>) | null = null;

/** Tests only: replaces DNS so no test performs a real lookup. */
export function setBrowserUrlResolverForTesting(resolve: ((host: string) => Promise<string[]>) | null): void {
    resolverOverride = resolve;
}

/**
 * Gate for every URL browser_tool is asked to open or replay: http(s) only, no credentials, and
 * (by default) private/loopback targets are allowed for local testing. With BROWSER_ALLOW_PRIVATE=0
 * they are refused except hosts in BROWSER_ALLOW_HOSTS (comma-separated `host` or `host:port`,
 * e.g. `localhost:3111`). Cloud metadata addresses are never allowed in any mode.
 */
export function checkBrowserUrl(url: string): Promise<UrlCheck> {
    return checkPublicHttpUrl(url, {
        // Private targets are allowed by default so local apps can be tested; set
        // BROWSER_ALLOW_PRIVATE=0 for a hardened deployment and list exceptions in BROWSER_ALLOW_HOSTS.
        allowPrivate: process.env.BROWSER_ALLOW_PRIVATE !== '0',
        allowHosts: (process.env.BROWSER_ALLOW_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean),
        resolve: resolverOverride ?? undefined,
    });
}
