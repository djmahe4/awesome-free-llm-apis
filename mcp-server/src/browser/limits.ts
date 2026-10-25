/** Per-call ceiling for one Chrome DevTools call (ms). A hung page or crashed Chrome must not block a caller forever. */
export const callTimeoutMs = (): number => {
    const n = Number(process.env.BROWSER_CALL_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 60_000;
};

/** A caller-supplied duration clamped into [min, max]; anything that is not a number falls back to `fallback`. */
export function boundedMs(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

export class BrowserCallTimeout extends Error {
    constructor(name: string, ms: number) {
        super(`Browser call '${name}' timed out after ${ms}ms`);
        this.name = 'BrowserCallTimeout';
    }
}

/**
 * Only transport-level failures are worth retrying. A rejected argument, a missing tool or one of our own
 * timeouts would fail the same way three times (and a timed-out call may still be running in Chrome).
 */
export function isTransientError(err: unknown): boolean {
    const e = err as { name?: string; message?: string; code?: string } | null;
    if (e?.name === 'BrowserCallTimeout') return false;
    const text = `${e?.code ?? ''} ${e?.message ?? err}`;
    return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|connection (closed|lost|reset)|transport|disconnected|not connected|stream (closed|ended)/i.test(text);
}
