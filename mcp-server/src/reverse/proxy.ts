import { spawn, type ChildProcess, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { sanitizeText, type SanitizeResult } from './sanitize.js';

export type ProxyErrorCode =
  | 'not_allowed'
  | 'timeout'
  | 'output_too_large'
  | 'closed'
  | 'protocol_error';

export class ProxyError extends Error {
  public readonly code: ProxyErrorCode;

  constructor(message: string, code: ProxyErrorCode) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
  }
}

/**
 * Validates CLI arguments for REA execution.
 * Enforces threat model rule: never expose `setup` (rewrites configs) or `--http` (unauthenticated daemon).
 */
export function reaMcpArgs(reaPath: string, extraArgs: string[] = []): string[] {
  for (const arg of extraArgs) {
    if (arg === 'setup' || arg === '--http' || arg.includes('setup') || arg.includes('--http')) {
      throw new Error(`Forbidden REA argument: ${arg}`);
    }
  }
  return [reaPath, 'mcp', ...extraArgs];
}

/**
 * Forcefully terminates a process and all its child descendants cross-platform.
 * On Windows: taskkill /pid <PID> /T /F
 * On POSIX: SIGKILL to process group or PID
 */
export function treeKill(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Ignore if process already exited or sandbox denies RPC
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already dead
    }
  } else {
    try {
      // Try killing process group first if detached
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Ignore if already dead
      }
    }
  }
}

export interface ReaProxyOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  pins?: Record<string, string>;
}

export interface BlockedToolInfo {
  name: string;
  reason: string;
}

export interface ProxyStartResult {
  callable: string[];
  blocked: BlockedToolInfo[];
  pins: Record<string, string>;
  serverInfo?: Record<string, unknown>;
}

export interface ProxyCallResult {
  text: string;
  flags: SanitizeResult['flags'];
  untrustedContent: boolean;
  provenance: {
    source: string;
    sha256: string;
    tool: string;
    trusted: false;
  };
  raw?: any;
}

export class ReaProxy {
  private child: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number | string, {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer?: NodeJS.Timeout;
    method?: string;
  }>();
  private stdoutBuffer = '';
  private isClosed = false;

  private callableList: string[] = [];
  private blockedList: BlockedToolInfo[] = [];
  private schemaPins: Record<string, string> = {};

  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly initialPins?: Record<string, string>;

  constructor(options: ReaProxyOptions) {
    this.command = options.command;
    this.args = options.args || [];
    this.env = options.env || (process.env as Record<string, string>);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    this.initialPins = options.pins;
  }

  public get callable(): string[] {
    return [...this.callableList];
  }

  public get blocked(): BlockedToolInfo[] {
    return [...this.blockedList];
  }

  public get pins(): Record<string, string> {
    return { ...this.schemaPins };
  }

  private hashTool(tool: any): string {
    const canonical = {
      name: tool.name || '',
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.isClosed) {
      throw new ProxyError('Proxy is closed', 'closed');
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  public async start(): Promise<ProxyStartResult> {
    if (this.child) {
      return {
        callable: this.callable,
        blocked: this.blocked,
        pins: this.pins,
      };
    }

    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      detached: process.platform !== 'win32',
    });

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    this.child.on('exit', () => {
      this.isClosed = true;
      for (const [_, req] of this.pending) {
        if (req.timer) clearTimeout(req.timer);
        req.reject(new ProxyError('Engine process terminated', 'closed'));
      }
      this.pending.clear();
      this.child = null;
    });

    // 1. Handshake Step 1: initialize
    const initResponse = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'awesome-free-llm-apis', version: '1.1.2' },
    });

    // 2. Handshake Step 2: notifications/initialized
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // 3. Handshake Step 3: tools/list
    const toolsResponse = await this.request('tools/list', {});
    const tools: any[] = toolsResponse?.tools || [];

    this.callableList = [];
    this.blockedList = [];
    this.schemaPins = {};

    for (const tool of tools) {
      const name = tool.name;
      const hash = this.hashTool(tool);
      this.schemaPins[name] = hash;

      // Check pin mismatch
      if (this.initialPins && this.initialPins[name] && this.initialPins[name] !== hash) {
        this.blockedList.push({ name, reason: 'schema_changed' });
        continue;
      }

      // Allowlist check: Must be readOnlyHint: true and not setup or mutating
      const isReadOnly = tool.annotations?.readOnlyHint === true;
      const isSetupOrMutate = name.toLowerCase().includes('setup') || name.toLowerCase().startsWith('write_');

      if (isReadOnly && !isSetupOrMutate) {
        this.callableList.push(name);
      } else {
        const reason = isSetupOrMutate ? (name.includes('setup') ? 'setup_tool' : 'mutating_tool') : 'not_read_only';
        this.blockedList.push({ name, reason });
      }
    }

    return {
      callable: this.callable,
      blocked: this.blocked,
      pins: this.pins,
      serverInfo: initResponse?.serverInfo,
    };
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.isClosed) {
      return Promise.reject(new ProxyError('Proxy is closed', 'closed'));
    }

    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          try {
            this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
          } catch {
            // Process might be dead
          }
          reject(new ProxyError(`Request timed out after ${this.requestTimeoutMs}ms`, 'timeout'));
        }
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (this.stdoutBuffer.length + chunk.length > this.maxResponseBytes) {
      this.stdoutBuffer = '';
      const err = new ProxyError('Response exceeded maximum buffer limit', 'output_too_large');
      for (const [_, req] of this.pending) {
        if (req.timer) clearTimeout(req.timer);
        req.reject(err);
      }
      this.pending.clear();
      this.close();
      return;
    }

    this.stdoutBuffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const req = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (req.timer) clearTimeout(req.timer);

          if (msg.error) {
            req.reject(new ProxyError(msg.error.message || 'JSON-RPC protocol error', 'protocol_error'));
          } else {
            req.resolve(msg.result);
          }
        }
      } catch {
        // Discard malformed diagnostic lines from engine
      }
    }
  }

  public async call(toolName: string, args: Record<string, unknown>): Promise<ProxyCallResult> {
    if (this.isClosed) {
      throw new ProxyError('Proxy is closed', 'closed');
    }
    if (!this.callableList.includes(toolName)) {
      throw new ProxyError(`Tool "${toolName}" is not callable`, 'not_allowed');
    }

    const res = await this.request('tools/call', { name: toolName, arguments: args });
    const rawText = res?.content?.[0]?.text ?? (typeof res === 'string' ? res : JSON.stringify(res));

    const sanitized = sanitizeText(rawText);
    const untrustedContent = Boolean(res?._meta?.provenance?.untrusted_content ?? true);
    const sha256 = crypto.createHash('sha256').update(rawText).digest('hex');

    return {
      text: sanitized.text,
      flags: sanitized.flags,
      untrustedContent,
      provenance: {
        source: 'rea-mcp',
        sha256,
        tool: toolName,
        trusted: false,
      },
      raw: res,
    };
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    for (const [_, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new ProxyError('Proxy is closed', 'closed'));
    }
    this.pending.clear();

    if (this.child) {
      const pid = this.child.pid;
      try {
        this.child.stdin?.end();
      } catch {
        // ignore
      }
      if (pid) {
        treeKill(pid);
      }
      this.child = null;
    }
  }
}
