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

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** A screenshot file name that cannot leave its folder: last path segment only, plain characters, image extension. */
export function safeScreenshotName(requested: unknown, sessionId: string, now: number): string {
    const fallback = `screenshot_${safeSessionSegment(sessionId)}_${now}.png`;
    if (typeof requested !== 'string') return fallback;
    const last = requested.split(/[\\/]/).pop() ?? '';
    const plain = last.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
    if (!plain || /^_+$/.test(plain)) return fallback;
    return IMAGE_EXT.test(plain) ? plain : `${plain}.png`;
}

/** A session id as a single path segment (it ends up in checkpoint and screenshot file names). */
export function safeSessionSegment(id: unknown): string {
    // every separator and every ".." becomes "_", so distinct ids stay distinct and none can climb out
    const cleaned = String(id ?? '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[_.]+|[_.]+$/g, '')
        .slice(0, 80);
    return cleaned || 'session';
}

/** evaluate: caller JS runs inside the page. On by default; BROWSER_ALLOW_EVALUATE=0 turns it off. */
export const evaluateAllowed = (): boolean => process.env.BROWSER_ALLOW_EVALUATE !== '0';
export const MAX_EVALUATE_SOURCE_CHARS = 20_000;
export const MAX_EVALUATE_RESULT_CHARS = 100_000;
