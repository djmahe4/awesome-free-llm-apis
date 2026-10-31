import { callTimeoutMs, BrowserCallTimeout, isTransientError } from './limits.js';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { NetworkStateTracker } from '../utils/NetworkStateTracker.js';
import { StdioDevToolsClient } from './DevToolsClient.js';
import type { DevToolsClient } from './DevToolsClient.js';
import { evaluateStructured, parseDevToolsResult, withRetry } from './DevToolsCall.js';
import { INTERCEPTOR_INSTALL_SCRIPT, INTERCEPTOR_DRAIN_SCRIPT } from './interceptor.js';
import { detectBlockingChallenge, type BlockingChallengeResult } from './BlockDetector.js';

export type BrowserSessionStatus =
    | 'INITIALIZED' | 'SURFACE_EXPLORED' | 'NODES_DISCOVERED' | 'PLAYER_CARDS_DISCOVERED'
    | 'AWAITING_USER_SELECTION' | 'EXECUTING_SELECTED_OPTION' | 'PAUSED' | 'RESUMED'
    | 'COMPLETED' | 'FAILED';

export interface EngineCaps {
    networkBodiesViaDevTools: boolean | null; // null = not yet probed
    interceptorInstalled: boolean;
    probedAt?: string;
}

export interface CapturedRequest {
    seq: number;
    url: string;
    method: string;
    status: number;
    contentType: string;
    bytes: number;
    body?: string;
    truncated: boolean;
    ts: number;
}

export class DomStateFingerprinter {
    static computeHash(snapshotText: string): string {
        if (!snapshotText) return '';
        const normalized = snapshotText
            .split('\n')
            .map(l => l.trim())
            // volatile lines only: a timestamp or a duration like "120ms" / "1.5 ms" (the substring "ms" alone also
            // matched items, forms, terms and programs, so changes in those lines went unseen)
            .filter(l => !/timestamp/i.test(l) && !/\b\d+(\.\d+)?\s?ms\b/i.test(l))
            .join('\n');
        return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    }

    static hasStateChanged(previousHash: string, currentHash: string): boolean {
        if (!previousHash || !currentHash) return true;
        return previousHash !== currentHash;
    }
}

/**
 * Owns one chrome-devtools-mcp client plus per-session browser state:
 * current URL, DOM fingerprint, the network interceptor's read cursor,
 * and the probed capability set for this engine instance.
 */
export class BrowserSession {
    readonly sessionId: string;
    readonly client: DevToolsClient;
    lastUsedAt: number = Date.now();
    currentUrl: string | null = null;
    lastFingerprint: string = '';
    /** Raw text of the most recent take_snapshot call — kept so callers (dispatch.ts's
     *  handleClick/handleWait) can diff structurally against the *next* snapshot without
     *  re-capturing; not persisted to checkpoints (see ScrapingSessionCheckpoint.lastDiffSummary). */
    lastSnapshotText: string = '';
    netLogCursor: number = 0;
    engineCaps: EngineCaps = { networkBodiesViaDevTools: null, interceptorInstalled: false };
    networkTracker = new NetworkStateTracker();
    status: BrowserSessionStatus = 'INITIALIZED';
    /** Set by every snapshot() call — a scrape failure downstream can check this to tell
     *  "genuinely empty page" apart from "blocked by Cloudflare/CAPTCHA" before reporting. */
    lastBlockCheck: BlockingChallengeResult = { blocked: false };

    constructor(sessionId: string, client: DevToolsClient) {
        this.sessionId = sessionId;
        this.client = client;
    }

    touch() {
        this.lastUsedAt = Date.now();
    }

    /** One DevTools call, bounded by BROWSER_CALL_TIMEOUT_MS (default 60 s) so a hung Chrome cannot block forever. */
    private callWithTimeout(name: string, args: Record<string, any>): Promise<any> {
        const ms = callTimeoutMs();
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrowserCallTimeout(name, ms)), ms); });
        return Promise.race([this.client.callTool({ name, arguments: args }), timeout]).finally(() => clearTimeout(timer));
    }

    async call(name: string, args: Record<string, any> = {}, opts: { retries?: number } = {}): Promise<any> {
        this.touch();
        const res = await withRetry(() => this.callWithTimeout(name, args), {
            attempts: opts.retries ?? 3,
            retryOn: isTransientError,
        });
        // chrome-devtools-mcp reports tool failures via `isError` without throwing —
        // e.g. "Could not find Google Chrome executable". Without this check
        // navigate_page failures look like successes to callers.
        if (res && res.isError) {
            const text = Array.isArray(res.content) ? res.content.map((c: any) => c?.text ?? '').join('\n') : '';
            throw new Error(`${name} failed: ${text || 'unknown MCP error'}`);
        }
        return res;
    }

    async evaluate<T = any>(fnSource: string, args?: Record<string, any>) {
        this.touch();
        return evaluateStructured<T>(this.client, fnSource, args);
    }

    async navigate(url: string): Promise<void> {
        await this.call('navigate_page', { url });
        this.currentUrl = url;
        this.lastFingerprint = '';
        this.lastSnapshotText = '';
        this.lastBlockCheck = { blocked: false };
        // (Re-)install the network interceptor on every navigation — it does not
        // survive a full page load, and SPA route changes are hooked internally
        // via history.pushState/popstate inside the injected script.
        try {
            const res = await this.evaluate(INTERCEPTOR_INSTALL_SCRIPT);
            this.engineCaps.interceptorInstalled = res.ok;
        } catch {
            this.engineCaps.interceptorInstalled = false;
        }
        this.netLogCursor = 0;
    }

    async snapshot(verbose = false): Promise<{ text: string; fingerprint: string }> {
        const raw = await this.call('take_snapshot', { verbose });
        const text = raw?.content?.[0]?.text || '';
        const fingerprint = DomStateFingerprinter.computeHash(text);
        this.lastFingerprint = fingerprint;
        this.lastSnapshotText = text;
        // Cheap marker scan only here — this runs on every dom-stable poll tick (every
        // 300ms in dispatch.ts's handleWait), so the parse+diff structural heuristic is
        // deliberately NOT run here. Callers that already computed a diff (handleClick,
        // handleWait's exit) can upgrade this via applyStructuralSignal() below.
        this.lastBlockCheck = detectBlockingChallenge(text);
        return { text, fingerprint };
    }

    /**
     * Upgrades lastBlockCheck with a structural-interstitial signal a caller already computed
     * from a diffSnapshots() result (see dispatch.ts's handleClick/handleWait) — never recomputes
     * the diff itself, so it adds no cost beyond what the caller already paid for.
     */
    applyStructuralSignal(structuralSignal: boolean): void {
        if (structuralSignal && !this.lastBlockCheck.blocked) {
            this.lastBlockCheck = { blocked: true, type: 'unknown', evidence: 'structural-interstitial' };
        }
    }

    /**
     * Drains newly captured network requests from the in-page interceptor ring
     * buffer since the last drain. This is the tier that catches traffic fired
     * AFTER navigate (tab clicks etc) — the case that mattered for SofaScore,
     * since list_network_requests alone only gives markdown-formatted URLs.
     */
    async drainInterceptedRequests(): Promise<CapturedRequest[]> {
        const res = await this.evaluate<{ entries: CapturedRequest[]; cursor: number }>(
            INTERCEPTOR_DRAIN_SCRIPT,
            { since: this.netLogCursor }
        );
        if (!res.ok || !res.json) return [];
        this.netLogCursor = res.json.cursor ?? this.netLogCursor;
        return res.json.entries ?? [];
    }

    /**
     * Probes whether chrome-devtools-mcp's network tooling returns response BODIES
     * (not just URLs/status). Must be established at runtime, not assumed — cached
     * on this session (and intended to be cached in site memory across sessions).
     */
    async probeBodyCapture(): Promise<boolean> {
        if (this.engineCaps.networkBodiesViaDevTools !== null) {
            return this.engineCaps.networkBodiesViaDevTools;
        }
        try {
            const listRes = await this.call('list_network_requests', { resourceTypes: ['fetch', 'xhr'], pageSize: 5 });
            const parsed = parseDevToolsResult(listRes);
            const hasBody = /"body"|"responseBody"|content-length/i.test(parsed.text) && parsed.text.length > 200;
            this.engineCaps.networkBodiesViaDevTools = hasBody;
        } catch {
            this.engineCaps.networkBodiesViaDevTools = false;
        }
        this.engineCaps.probedAt = new Date().toISOString();
        return this.engineCaps.networkBodiesViaDevTools;
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

export interface ProfileDirOptions {
    /** Explicit exact profile dir — highest precedence; caller owns collision risk. */
    userDataDir?: string;
    /** Injected for tests; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /** Injected for tests; defaults to os.tmpdir(). */
    tmpdir?: string;
}

/** Windows forbids `<>:"/\|?*` and reserved device names in file names. */
function sanitizeProfileSegment(sessionId: string): string {
    const safe = (sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)) || 'default';
    return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(safe) ? `s_${safe}` : safe;
}

/** Expand `%NAME%` references (Windows-style) and strip stray surrounding quotes. */
function expandEnvPath(value: string, env: NodeJS.ProcessEnv): string {
    return value
        .replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match)
        .replace(/^"(.*)"$/, '$1');
}

/**
 * Resolve the chrome profile dir for a session so zero CLI args still work:
 *
 *   1. explicit `userDataDir` option (exact dir — existing contract)
 *   2. `WIKI_BROWSER_PROFILE_DIR` env var (base dir)
 *   3. `CHROME_USER_DATA_DIR` env var (base dir)
 *   4. `<tmpdir>/wiki-browser-profiles`
 *
 * Env vars name the BASE; every session still gets its own subdirectory
 * because chrome-devtools-mcp refuses to share one profile between
 * concurrent instances ("The browser is already running for <profile>").
 * Paths are built with path.join so they are correct on Windows too.
 */
export function profileDirFor(sessionId: string, opts: ProfileDirOptions = {}): string {
    if (opts.userDataDir) return opts.userDataDir;
    const env = opts.env ?? process.env;
    const base = env.WIKI_BROWSER_PROFILE_DIR
        ? expandEnvPath(env.WIKI_BROWSER_PROFILE_DIR, env)
        : env.CHROME_USER_DATA_DIR
            ? expandEnvPath(env.CHROME_USER_DATA_DIR, env)
            : path.join(opts.tmpdir ?? os.tmpdir(), 'wiki-browser-profiles');
    return path.join(base, sanitizeProfileSegment(sessionId));
}

export async function createRealBrowserSession(sessionId: string, opts: { userDataDir?: string; connectTimeoutMs?: number } = {}): Promise<BrowserSession> {
    // chrome-devtools-mcp's default profile is a single fixed path — a second
    // session would fail with "The browser is already running for <profile>".
    // Give each session its own profile dir ( --isolated conflicts with
    // --executable-path, so we cannot use that instead ). The dir is
    // env-configurable via profileDirFor() so Windows needs no CLI args.
    const userDataDir = profileDirFor(sessionId, opts);
    const client = await StdioDevToolsClient.connect({ ...opts, userDataDir });
    return new BrowserSession(sessionId, client);
}
