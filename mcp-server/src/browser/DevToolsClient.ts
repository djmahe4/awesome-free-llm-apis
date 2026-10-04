import fs from 'node:fs';
import path from 'node:path';

/**
 * The seam that makes BrowserSession testable without spawning Chrome.
 * StdioDevToolsClient talks to `chrome-devtools-mcp` (spawned as a child MCP
 * server over stdio) with the exact args already proven working in
 * scripts/smoke/test_tool_network_scraping_capabilities.ts:12-30.
 */
export interface DevToolsCallRequest {
    name: string;
    arguments?: Record<string, any>;
}

export interface DevToolsClient {
    callTool(req: DevToolsCallRequest): Promise<any>;
    close(): Promise<void>;
}

export interface StdioDevToolsClientOptions {
    /** Optional user-data-dir so a session can persist cookies/localStorage across restarts. */
    userDataDir?: string;
    /** Milliseconds to wait for the child process to accept the MCP handshake. */
    connectTimeoutMs?: number;
}

export interface ChromeCandidateOptions {
    /** Injected for tests; defaults to process.platform. */
    platform?: string;
    /** Injected for tests; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
}

/** Expand `%NAME%` references (Windows-style) and strip stray surrounding quotes. */
function expandWinEnv(value: string, env: NodeJS.ProcessEnv): string {
    return value
        .replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match)
        .replace(/^"(.*)"$/, '$1');
}

/**
 * Where a chromium-based browser might live, in priority order.
 *
 * First entry is always `CHROME_PATH` (environment variable) so any platform
 * — Windows included — can point at a custom install without code or CLI
 * args. The rest are well-known per-platform install locations; on Windows
 * `%PROGRAMFILES%`/`%LOCALAPPDATA%` are honored (with `%VAR%` expansion) and
 * Edge is the last-resort fallback since every Windows box ships it.
 */
export function chromeCandidates(opts: ChromeCandidateOptions = {}): string[] {
    const platform = opts.platform ?? process.platform;
    const env = opts.env ?? process.env;
    const out: string[] = [];
    const push = (raw?: string | null): void => {
        if (!raw) return;
        const value = platform === 'win32' ? expandWinEnv(raw, env) : raw;
        if (value && !out.includes(value)) out.push(value);
    };

    push(env.CHROME_PATH);

    if (platform === 'win32') {
        const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
            .filter((r): r is string => !!r);
        for (const root of roots) {
            push(path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
        for (const root of roots) {
            push(path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'));
        }
        for (const root of [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA]) {
            push(path.win32.join(root ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
        }
        // Hardcoded fallbacks when the usual env vars are absent.
        push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
        push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
        push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    } else if (platform === 'darwin') {
        push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        push('/Applications/Chromium.app/Contents/MacOS/Chromium');
        if (env.HOME) {
            push(path.join(env.HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
            push(path.join(env.HOME, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
        }
    } else {
        push('/usr/bin/chromium');
        push('/usr/bin/chromium-browser');
        push('/usr/bin/google-chrome');
        push('/usr/bin/google-chrome-stable');
        push('/opt/google/chrome/chrome');
        push('/snap/bin/chromium');
    }
    return out;
}

/**
 * chrome-devtools-mcp defaults to channel 'stable' (/opt/google/chrome/chrome),
 * which may be absent — only chromium may be installed. Resolve a real binary
 * so the MCP does not fail with "Could not find Google Chrome executable".
 *
 * On Windows there is no separate execute permission bit (Node maps X_OK to a
 * plain existence check), so F_OK is used there.
 */
export async function resolveChromeExecutable(opts: ChromeCandidateOptions = {}): Promise<string | undefined> {
    const { access } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    const platform = opts.platform ?? process.platform;
    const mode = platform === 'win32' ? constants.F_OK : constants.X_OK;
    for (const candidate of chromeCandidates(opts)) {
        try {
            await access(candidate, mode);
            return candidate;
        } catch {
            // try next
        }
    }
    return undefined;
}

export interface NpxInvocationOptions {
    platform?: string;
    execPath?: string;
    env?: NodeJS.ProcessEnv;
    /** Injected for tests; defaults to fs.existsSync. */
    exists?: (p: string) => boolean;
}

/**
 * How to launch `npx`. The MCP SDK's stdio transport spawns without a shell,
 * and Node >= 18.20 refuses to execute `.cmd` shims directly (EINVAL), so on
 * Windows we run npm's npx CLI script under the current node binary instead
 * of the npx.cmd shim. Falls back to npx.cmd only when no CLI script exists.
 */
export function npxInvocation(opts: NpxInvocationOptions = {}): { command: string; args: string[] } {
    const platform = opts.platform ?? process.platform;
    if (platform !== 'win32') return { command: 'npx', args: [] };

    const env = opts.env ?? process.env;
    const execPath = opts.execPath ?? process.execPath;
    const exists = opts.exists ?? ((p: string) => fs.existsSync(p));

    const candidates: string[] = [path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')];
    // Set when this process itself was launched via npm/npx.
    const npmExecPath = env.npm_execpath;
    if (npmExecPath && /npx-cli\.js$/i.test(npmExecPath)) candidates.push(npmExecPath);

    for (const cli of candidates) {
        if (exists(cli)) return { command: execPath, args: [cli] };
    }
    return { command: 'npx.cmd', args: [] };
}

/**
 * Real implementation. Deliberately runs headed (no --headless) — the tool is meant
 * to be visually observable while it drives a scrape, matching how the SofaScore
 * debugging scripts (e.g. sofascore_interactive_debug.ts) were designed to run.
 */
export class StdioDevToolsClient implements DevToolsClient {
    private client: any;
    private transport: any;

    private constructor(client: any, transport: any) {
        this.client = client;
        this.transport = transport;
    }

    static async connect(opts: StdioDevToolsClientOptions = {}): Promise<StdioDevToolsClient> {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

        const args = ['-y', 'chrome-devtools-mcp', '--chrome-arg=--no-sandbox', '--allow-unrestricted-paths', '--no-page-id-routing'];
        const executablePath = await resolveChromeExecutable();
        if (executablePath) {
            args.push(`--executable-path=${executablePath}`);
        }
        if (opts.userDataDir) {
            args.push(`--user-data-dir=${opts.userDataDir}`);
        }

        const npx = npxInvocation();
        const transport = new StdioClientTransport({ command: npx.command, args: [...npx.args, ...args] });
        const client = new Client({ name: 'browser_tool', version: '2.0.0' }, { capabilities: {} });

        const timeoutMs = opts.connectTimeoutMs ?? 60_000;
        await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`chrome-devtools-mcp did not connect within ${timeoutMs}ms`)), timeoutMs)),
        ]);

        return new StdioDevToolsClient(client, transport);
    }

    static async connectCustom(opts: { command: string; args: string[]; connectTimeoutMs?: number }): Promise<StdioDevToolsClient> {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

        const transport = new StdioClientTransport({ command: opts.command, args: opts.args });
        const client = new Client({ name: 'custom_mcp_client', version: '1.0.0' }, { capabilities: {} });

        const timeoutMs = opts.connectTimeoutMs ?? 30_000;
        await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Custom MCP process (${opts.command}) did not connect within ${timeoutMs}ms`)), timeoutMs)),
        ]);

        return new StdioDevToolsClient(client, transport);
    }

    async callTool(req: DevToolsCallRequest): Promise<any> {
        return this.client.callTool({ name: req.name, arguments: req.arguments ?? {} });
    }

    async close(): Promise<void> {
        try {
            await this.client.close();
        } catch {
            // best-effort — process teardown must never throw
        }
    }
}

/** In-memory fake for tests — never spawns a process. */
export class FakeDevToolsClient implements DevToolsClient {
    public calls: DevToolsCallRequest[] = [];
    public closed = false;
    constructor(private handler: (req: DevToolsCallRequest) => any = () => ({ content: [{ type: 'text', text: '' }] })) {}

    async callTool(req: DevToolsCallRequest): Promise<any> {
        this.calls.push(req);
        return this.handler(req);
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}
