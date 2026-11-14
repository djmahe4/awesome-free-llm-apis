# Reverse Proxy Core & REA Engine Containment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Phase 1 (`feat/reverse-proxy-core`) from `docs/plans/rev_tool.md`: a secure, sandboxed JSON-RPC stdio proxy (`ReaProxy`) for the REA reverse engineering engine with process tree-kill, request timeouts and cancellation, response output caps, schema hash pinning, evidence sanitization, and the foundational MCP tool handler supporting `status` and `list_capabilities`.

**Architecture:** A resilient stdio subprocess proxy (`ReaProxy`) spawns the isolated engine child process, executes the standard MCP initialization handshake (`initialize` -> `notifications/initialized` -> `tools/list`), enforces a strict read-only allowlist, and calculates SHA-256 schema hash pins to prevent tool poisoning. All returned text passes through `sanitizeText` to strip control characters, zero-width spaces, and bidi overrides while flagging large base64 blobs, with guaranteed cross-platform process tree termination (Windows `taskkill /pid <PID> /T /F` and POSIX process groups).

**Tech Stack:** TypeScript (Node 22+ ESM), `@modelcontextprotocol/sdk`, `vitest`, child_process (`spawn`, `execSync`), Node crypto (SHA-256), and existing project utilities (`sanitizeText`, `toMarkdownResponse`, precommit verification suite).

---

### Task 1: Core Proxy Protocol Errors, Argument Guard, and Process Tree-Kill

**Files:**
- Create: `mcp-server/src/reverse/proxy.ts`
- Test: `mcp-server/tests/reverse-proxy-core.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-proxy-core.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { ProxyError, reaMcpArgs, treeKill } from '../src/reverse/proxy.js';

describe('ProxyError', () => {
  it('instantiates with custom code and message', () => {
    const err = new ProxyError('Operation timed out', 'timeout');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProxyError');
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('Operation timed out');
  });

  it('supports all required error codes', () => {
    const codes = ['not_allowed', 'timeout', 'output_too_large', 'closed', 'protocol_error'] as const;
    for (const code of codes) {
      const err = new ProxyError(`Error ${code}`, code);
      expect(err.code).toBe(code);
    }
  });
});

describe('reaMcpArgs', () => {
  it('constructs basic mcp argument array', () => {
    const args = reaMcpArgs('/usr/local/bin/rea');
    expect(args).toEqual(['/usr/local/bin/rea', 'mcp']);
  });

  it('allows benign flags', () => {
    const args = reaMcpArgs('/usr/local/bin/rea', ['--json']);
    expect(args).toEqual(['/usr/local/bin/rea', 'mcp', '--json']);
  });

  it('refuses setup commands', () => {
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['setup'])).toThrow(/Forbidden REA argument/);
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['rea_setup'])).toThrow(/Forbidden REA argument/);
  });

  it('refuses --http network daemon exposure', () => {
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['--http'])).toThrow(/Forbidden REA argument/);
    expect(() => reaMcpArgs('/usr/local/bin/rea', ['mcp', '--http'])).toThrow(/Forbidden REA argument/);
  });
});

describe('treeKill', () => {
  it('terminates a spawned process and its tree cleanly', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;

    const isAlive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };

    expect(isAlive(pid)).toBe(true);
    treeKill(pid);
    await new Promise((r) => setTimeout(r, 400));
    expect(isAlive(pid)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/reverse-proxy-core.test.ts`
Expected: FAIL with "Cannot find module '../src/reverse/proxy.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/reverse/proxy.ts`:
```typescript
import { execSync } from 'node:child_process';

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
      // Ignore if process already exited
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
```

**Step 4: Run test to verify it passes**

Run: `cd mcp-server && npx vitest run tests/reverse-proxy-core.test.ts`
Expected: PASS (all tests pass)

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/proxy.ts mcp-server/tests/reverse-proxy-core.test.ts
git commit -m "feat(reverse): add proxy error types, argument validator, and tree-kill helper"
```

---

### Task 2: REA Proxy Lifecycle, Handshake, and Schema Pinning

**Files:**
- Modify: `mcp-server/src/reverse/proxy.ts`
- Test: `mcp-server/tests/reverse-proxy-handshake.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-proxy-handshake.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaProxy, ProxyError } from '../src/reverse/proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REA = path.join(here, '..', 'scripts', 'smoke', 'fixtures', 'fake-rea.mjs');

describe('ReaProxy Handshake & Tool Categorization', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('performs strict handshake in exact order and populates callable/blocked tools', async () => {
    const logPath = path.join(tmpDir, 'handshake-log.jsonl');
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: {
        ...process.env,
        FAKE_REA_LOG: logPath,
      } as Record<string, string>,
    });

    const info = await proxy.start();
    const logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const methods = logLines.map((m: any) => m.method);

    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(info.callable.sort()).toEqual(['analyze_javascript_application', 'get_evidence_bundle', 'inspect_artifact']);
    expect(info.blocked.some((b) => b.name === 'write_report')).toBe(true);
    expect(info.blocked.some((b) => b.name === 'rea_setup')).toBe(true);
    expect(proxy.callable.sort()).toEqual(['analyze_javascript_application', 'get_evidence_bundle', 'inspect_artifact']);

    await proxy.close();
  });

  it('blocks tools when schema hash differs from pinned hash', async () => {
    const firstProxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
    });
    const info1 = await firstProxy.start();
    await firstProxy.close();

    const secondProxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: {
        ...process.env,
        FAKE_REA_DESC: 'Tampered description with malicious instructions',
      } as Record<string, string>,
      pins: info1.pins,
    });

    const info2 = await secondProxy.start();
    expect(info2.blocked.some((b) => b.name === 'inspect_artifact' && b.reason === 'schema_changed')).toBe(true);
    expect(info2.callable.includes('inspect_artifact')).toBe(false);
    expect(info2.callable.includes('get_evidence_bundle')).toBe(true);

    await expect(secondProxy.call('inspect_artifact', {})).rejects.toThrow(ProxyError);
    await secondProxy.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/reverse-proxy-handshake.test.ts`
Expected: FAIL with "ReaProxy is not defined"

**Step 3: Write minimal implementation**

Update `mcp-server/src/reverse/proxy.ts` to add `ReaProxy`:
```typescript
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

export function reaMcpArgs(reaPath: string, extraArgs: string[] = []): string[] {
  for (const arg of extraArgs) {
    if (arg === 'setup' || arg === '--http' || arg.includes('setup') || arg.includes('--http')) {
      throw new Error(`Forbidden REA argument: ${arg}`);
    }
  }
  return [reaPath, 'mcp', ...extraArgs];
}

export function treeKill(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // Ignore if process already exited
    }
  } else {
    try {
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
```

**Step 4: Run test to verify it passes**

Run: `cd mcp-server && npx vitest run tests/reverse-proxy-handshake.test.ts`
Expected: PASS (both tests pass)

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/proxy.ts mcp-server/tests/reverse-proxy-handshake.test.ts
git commit -m "feat(reverse): implement ReaProxy initialization handshake and schema pinning"
```

---

### Task 3: Stdio Message Framing, Timeouts, Caps, and Output Sanitization

**Files:**
- Modify: `mcp-server/src/reverse/proxy.ts`
- Test: `mcp-server/tests/reverse-proxy-call.test.ts`
- Verify against: `mcp-server/scripts/smoke/reverse_proxy_smoke.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-proxy-call.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaProxy, ProxyError } from '../src/reverse/proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REA = path.join(here, '..', 'scripts', 'smoke', 'fixtures', 'fake-rea.mjs');

describe('ReaProxy Tool Execution, Timeouts, Buffering and Caps', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-call-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reassembles partial writes split across chunks', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'partial' } as Record<string, string>,
    });
    await proxy.start();
    const result = await proxy.call('inspect_artifact', { path: '/test/path' });
    expect(result.text).toContain('ev-1');
    expect(result.provenance.tool).toBe('inspect_artifact');
    expect(result.provenance.trusted).toBe(false);
    await proxy.close();
  });

  it('times out hung calls and sends cancellation notice to engine', async () => {
    const logPath = path.join(tmpDir, 'hang-log.jsonl');
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'hang', FAKE_REA_LOG: logPath } as Record<string, string>,
      requestTimeoutMs: 1200,
    });
    await proxy.start();

    let errCode = '';
    try {
      await proxy.call('inspect_artifact', {});
    } catch (e: any) {
      errCode = e.code;
    }
    expect(errCode).toBe('timeout');

    const logLines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(logLines.some((m: any) => m.method === 'notifications/cancelled')).toBe(true);

    await proxy.close();
  });

  it('rejects oversize responses, stops engine, and marks proxy closed', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'big' } as Record<string, string>,
      maxResponseBytes: 1024 * 1024,
    });
    await proxy.start();

    let errCode = '';
    try {
      await proxy.call('inspect_artifact', {});
    } catch (e: any) {
      errCode = e.code;
    }
    expect(errCode).toBe('output_too_large');

    let afterCode = '';
    try {
      await proxy.call('inspect_artifact', {});
    } catch (e: any) {
      afterCode = e.code;
    }
    expect(afterCode).toBe('closed');

    await proxy.close();
  });

  it('sanitizes hostile engine output and reports flags', async () => {
    const proxy = new ReaProxy({
      command: process.execPath,
      args: [FAKE_REA],
      env: { ...process.env, FAKE_REA_MODE: 'hostile' } as Record<string, string>,
    });
    await proxy.start();
    const result = await proxy.call('inspect_artifact', {});

    // Control chars, ANSI, zero-width, and bidi are stripped
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(result.text)).toBe(false);
    expect(result.flags).toContain('control_chars');
    expect(result.flags).toContain('zero_width');
    expect(result.flags).toContain('bidi');
    expect(result.flags).toContain('long_base64');
    expect(result.untrustedContent).toBe(true);
    expect(result.provenance.trusted).toBe(false);

    await proxy.close();
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd mcp-server && npx vitest run tests/reverse-proxy-call.test.ts`
Expected: PASS

**Step 3: Run the smoke script to verify complete alignment with challenge expectations**

Run: `cd mcp-server && npx tsx scripts/smoke/reverse_proxy_smoke.ts`
Expected:
```
PASS  P1 handshake order
PASS  P2 callable tools are the read-only allowlisted ones
PASS  P2 mutating and setup tools are listed as blocked with a reason
PASS  P2 a blocked tool is refused and never sent
PASS  P2 an allowed call returns evidence tagged untrusted
PASS  P3 hung call times out and the engine is told
PASS  P4 split writes are reassembled
PASS  P5 oversize output is refused and the engine is stopped
PASS  P6 closing kills the engine and its children
PASS  P7 a changed tool description is blocked
PASS  P7 the other pinned tools still work
PASS  P8 control, zero-width and bidi characters are removed
PASS  P8 the output is flagged
PASS  P8 untrusted marker from the engine is kept
PASS  P8 injected instructions cannot widen the tool list
PASS  P9 setup and --http are never launched

16/16 passed
```

**Step 4: Commit**

```bash
git add mcp-server/src/reverse/proxy.ts mcp-server/tests/reverse-proxy-call.test.ts
git commit -m "feat(reverse): add tool execution with timeouts, output caps, and evidence sanitization"
```

---

### Task 4: Reverse Tool Handler (`status` & `list_capabilities`)

**Files:**
- Create: `mcp-server/src/tools/reverse-tool.ts`
- Modify: `mcp-server/src/tools/index.ts`
- Test: `mcp-server/tests/reverse-tool-actions.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-tool-actions.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { reverseTool, type ReverseToolInput } from '../src/tools/reverse-tool.js';

describe('reverseTool MCP handler', () => {
  it('handles action status and reports node compatibility', async () => {
    const res = await reverseTool({ action: 'status' });
    expect(res.success).toBe(true);
    expect(res.action).toBe('status');
    expect(res.data.nodeVersion).toBeDefined();
    expect(typeof res.data.supportedNode).toBe('boolean');
    expect(res.data.engineStatus).toBeDefined();
  });

  it('rejects unsupported actions', async () => {
    const res = await reverseTool({ action: 'unknown_action' as any });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unsupported action');
  });

  it('enforces authorization for list_capabilities when target is specified', async () => {
    const res = await reverseTool({ action: 'list_capabilities', target: 'sample.exe' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('authorization');
  });

  it('allows list_capabilities when target has valid authorization framing', async () => {
    const res = await reverseTool({
      action: 'list_capabilities',
      target: 'sample.exe',
      authorization: 'ctf',
    });
    expect(res.success).toBe(true);
    expect(res.action).toBe('list_capabilities');
    expect(Array.isArray(res.data.capabilities)).toBe(true);
  });

  it('returns built-in static capabilities for list_capabilities without target', async () => {
    const res = await reverseTool({ action: 'list_capabilities' });
    expect(res.success).toBe(true);
    expect(res.data.capabilities).toContain('analyze_javascript');
    expect(res.data.capabilities).toContain('scan_github');
    expect(res.data.capabilities).toContain('inspect_gguf');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/reverse-tool-actions.test.ts`
Expected: FAIL with "Cannot find module '../src/tools/reverse-tool.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/tools/reverse-tool.ts`:
```typescript
import { ReaProxy, type BlockedToolInfo } from '../reverse/proxy.js';

export type ReverseAuthorization = 'ctf' | 'lab' | 'consent';

export interface ReverseToolInput {
  action: 'status' | 'list_capabilities';
  target?: string;
  authorization?: ReverseAuthorization;
  options?: Record<string, unknown>;
}

export interface ReverseToolResult {
  success: boolean;
  action: string;
  target?: string;
  data?: any;
  error?: string;
}

/** Checks whether the running Node.js version is >= 22.19 and not 23 or 25 */
export function checkNodeCompatibility(versionStr = process.versions.node): { supported: boolean; version: string; reason?: string } {
  const [major, minor] = versionStr.split('.').map(Number);
  if (major === 23 || major === 25) {
    return {
      supported: false,
      version: versionStr,
      reason: `Node.js ${major} is an experimental/odd release line; REA requires Node >= 22.19 (LTS) and rejects 23/25.`,
    };
  }
  if (major < 22 || (major === 22 && minor < 19)) {
    return {
      supported: false,
      version: versionStr,
      reason: `Node.js version is ${versionStr}; REA requires Node >= 22.19.`,
    };
  }
  return { supported: true, version: versionStr };
}

export async function reverseTool(input: ReverseToolInput): Promise<ReverseToolResult> {
  const { action, target, authorization, options } = input;

  if (action === 'status') {
    const nodeCheck = checkNodeCompatibility();
    const reaPath = process.env.REA_AGENTS_PATH || null;
    return {
      success: true,
      action: 'status',
      data: {
        nodeVersion: nodeCheck.version,
        supportedNode: nodeCheck.supported,
        nodeRequirement: '>= 22.19 (excluding 23 and 25)',
        engineStatus: reaPath ? 'configured' : 'standby',
        reaAgentsPath: reaPath,
        reason: nodeCheck.reason,
        builtInCapabilities: [
          'analyze_javascript',
          'scan_github',
          'inspect_gguf',
          'probe_memorization',
        ],
      },
    };
  }

  if (action === 'list_capabilities') {
    if (target && !authorization) {
      return {
        success: false,
        action: 'list_capabilities',
        target,
        error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".',
      };
    }

    const reaPath = process.env.REA_AGENTS_PATH;
    let engineCallable: string[] = [];
    let engineBlocked: BlockedToolInfo[] = [];

    if (reaPath) {
      try {
        const proxy = new ReaProxy({
          command: reaPath,
          requestTimeoutMs: 5000,
        });
        const info = await proxy.start();
        engineCallable = info.callable;
        engineBlocked = info.blocked;
        await proxy.close();
      } catch (err: any) {
        engineBlocked.push({ name: 'rea-engine', reason: err.message || 'Failed to initialize engine' });
      }
    }

    const staticCapabilities = [
      'analyze_javascript',
      'scan_github',
      'inspect_gguf',
      'probe_memorization',
    ];

    return {
      success: true,
      action: 'list_capabilities',
      target,
      data: {
        capabilities: [...staticCapabilities, ...engineCallable],
        staticProviders: ['javascript_ast', 'github_manifest', 'gguf_metadata'],
        nativeProviders: {
          ghidra: 'not_available',
          hopper: 'not_available',
          ida: 'not_available',
        },
        engineCallable,
        engineBlocked,
      },
    };
  }

  return {
    success: false,
    action: action || 'unknown',
    error: `Unsupported action: "${action}". Supported actions in Phase 1: "status", "list_capabilities".`,
  };
}
```

Update `mcp-server/src/tools/index.ts` to add the exports:
```typescript
export { reverseTool } from './reverse-tool.js';
export type { ReverseToolInput, ReverseAuthorization } from './reverse-tool.js';
```

**Step 4: Run test to verify it passes**

Run: `cd mcp-server && npx vitest run tests/reverse-tool-actions.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add mcp-server/src/tools/reverse-tool.ts mcp-server/src/tools/index.ts mcp-server/tests/reverse-tool-actions.test.ts
git commit -m "feat(reverse): implement reverse_tool status and list_capabilities actions"
```

---

### Task 5: Register `reverse_tool` in MCP Server

**Files:**
- Modify: `mcp-server/src/mcp/index.ts`
- Test: `mcp-server/tests/reverse-tool-mcp.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-tool-mcp.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { createMCPServer } from '../src/mcp/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('reverse_tool MCP Server Registration', () => {
  it('exposes reverse_tool with status and list_capabilities in ListTools', async () => {
    const server = await createMCPServer();
    const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const res = await handler({ method: 'tools/list', params: {} });
    const tool = res.tools.find((t: any) => t.name === 'reverse_tool');
    expect(tool).toBeDefined();
    expect(tool.description).toContain('Reverse engineering');
    expect(tool.inputSchema.properties.action.enum).toEqual(['status', 'list_capabilities']);
    expect(tool.inputSchema.properties.target).toBeDefined();
    expect(tool.inputSchema.properties.authorization).toBeDefined();
    expect(tool.inputSchema.properties.options).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['action']);
  });

  it('dispatches reverse_tool status call correctly', async () => {
    const server = await createMCPServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const res = await handler({
      method: 'tools/call',
      params: {
        name: 'reverse_tool',
        arguments: { action: 'status' },
      },
    });

    expect(res.content).toBeDefined();
    expect(res.content[0].text).toContain('nodeVersion');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd mcp-server && npx vitest run tests/reverse-tool-mcp.test.ts`
Expected: FAIL with "tool is not defined" or "reverse_tool" not found

**Step 3: Write minimal implementation**

In `mcp-server/src/mcp/index.ts`:
1. Add import:
```typescript
import { reverseTool } from '../tools/reverse-tool.js';
```
2. Add tool schema inside `ListToolsRequestSchema` `tools: [...]`:
```typescript
      {
        name: 'reverse_tool',
        description: [
          'Reverse engineering analysis and REA proxy with strict read-only containment and evidence provenance.',
          '',
          'USER STORY: Safely inspect binaries, JavaScript/Electron bundles, and architectures in an isolated sandbox.',
          'All engine output is treated as hostile data, sanitized against control/bidi injections, and capped.',
          '',
          'ACTIONS:',
          '  status              — Validate Node runtime version and REA engine availability.',
          '  list_capabilities   — Discover callable read-only tools and analysis providers.',
          '',
          'AUTHORIZATION: Requires authorization ("ctf" | "lab" | "consent") when targeting external artifacts.',
        ].join('\n'),
        inputSchema: {
          type: 'object' as const,
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'list_capabilities'],
              description: 'Reverse engineering action to perform.',
            },
            target: {
              type: 'string',
              description: 'Target path or URL for analysis.',
            },
            authorization: {
              type: 'string',
              enum: ['ctf', 'lab', 'consent'],
              description: 'Authorization context: ctf, lab, or consent.',
            },
            options: {
              type: 'object',
              description: 'Optional execution parameters.',
            },
          },
          required: ['action'],
        },
      },
```
3. Add dispatch case inside `CallToolRequestSchema` `switch (name)`:
```typescript
      case 'reverse_tool': {
        const result = await reverseTool(args as any);
        return toMarkdownResponse(result);
      }
```

**Step 4: Run test to verify it passes**

Run: `cd mcp-server && npx vitest run tests/reverse-tool-mcp.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add mcp-server/src/mcp/index.ts mcp-server/tests/reverse-tool-mcp.test.ts
git commit -m "feat(reverse): register reverse_tool in MCP server list and call handlers"
```

---

### Task 6: Dashboard Playground, Quickstart Tab, and Docs Alignment

**Files:**
- Modify: `mcp-server/dashboard/js/04-playground-form.js`
- Modify: `mcp-server/dashboard/index.html`
- Create: `mcp-server/docs/skill/references/reverse_tool.md`
- Modify: `mcp-server/docs/skill/SKILL.md`

**Step 1: Update Playground Form**

In `mcp-server/dashboard/js/04-playground-form.js`, add `reverse_tool` to `const TOOLS = [...]`:
```javascript
  {
    id: 'reverse_tool',
    name: 'Reverse Tool',
    desc: 'Reverse engineering analysis and REA proxy with strict read-only containment',
    fields: [
      {
        id: 'action',
        label: 'Action',
        type: 'select',
        options: ['status', 'list_capabilities'],
        defaultValue: 'status',
        required: true,
      },
      {
        id: 'target',
        label: 'Target',
        type: 'text',
        placeholder: 'e.g., /path/to/binary or sample.js',
      },
      {
        id: 'authorization',
        label: 'Authorization',
        type: 'select',
        options: ['ctf', 'lab', 'consent'],
        defaultValue: 'lab',
      },
      {
        id: 'options',
        label: 'Options (JSON)',
        type: 'textarea',
        placeholder: '{}',
      },
    ],
  },
```

**Step 2: Update Quickstart Tab in `dashboard/index.html`**

In `mcp-server/dashboard/index.html`, add the quickstart card for `reverse_tool`:
```html
          <details class="qs-tool-card">
            <summary class="qs-tool-summary">
              <span class="qs-tool-name">reverse_tool</span>
              <span class="qs-badge qs-badge-free">0 tokens</span>
            </summary>
            <div class="qs-tool-body">
              <p>Reverse engineering analysis and REA proxy with strict read-only containment and evidence provenance.</p>
              <table class="qs-table">
                <thead>
                  <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>action</code></td><td>string</td><td>Action to execute: <code>status</code> or <code>list_capabilities</code></td></tr>
                  <tr><td><code>target</code></td><td>string</td><td>Target path or URL for analysis</td></tr>
                  <tr><td><code>authorization</code></td><td>string</td><td>Authorization context: <code>ctf</code>, <code>lab</code>, or <code>consent</code></td></tr>
                  <tr><td><code>options</code></td><td>object</td><td>Additional tool options</td></tr>
                </tbody>
              </table>
            </div>
          </details>
```

**Step 3: Create Reference Documentation & Update SKILL.md**

Create `mcp-server/docs/skill/references/reverse_tool.md`:
```markdown
# reverse_tool Reference

## Overview
`reverse_tool` exposes a secure proxy over Reverse Engineer Anything (REA) and static analysis engines with strict read-only containment, evidence provenance tracking, and hostile output sanitization.

## Threat Model & Containment
- **Read-Only by Default:** Mutating, file-writing, and network execution tools are blocked before submission to the engine.
- **Output Sanitization:** All text returned from the engine passes through `sanitizeText` to eliminate ANSI escapes, control characters, zero-width characters, and bidirectional overrides.
- **Schema Pinning:** Tool descriptions and schemas are hashed with SHA-256; any modification between sessions blocks the tool.
- **Tree-Kill:** Processes and their descendants are terminated with Windows `taskkill /pid <PID> /T /F` or POSIX process groups.
- **No Setup or HTTP:** Commands matching `setup` or `--http` are refused.

## Actions
### `status`
Checks the Node.js runtime version (requiring Node >= 22.19, rejecting odd versions 23/25) and reports REA engine connectivity.

### `list_capabilities`
Discovers allowlisted read-only tools and reports available analysis providers. Requires `authorization` framing (`ctf` | `lab` | `consent`) when a target artifact is specified.
```

In `mcp-server/docs/skill/SKILL.md`, append the `reverse_tool` specification:
```markdown
### `reverse_tool`
Reverse engineering analysis and REA proxy with strict read-only containment and evidence provenance.

**When to use:** For static analysis, binary/bundle inspection, and architecture discovery in authorized CTF, lab, or consent engagements.

**Inputs:**
- `action` (required): `'status' | 'list_capabilities'`
- `target` (optional): Path to target file or artifact.
- `authorization` (required if target provided): `'ctf' | 'lab' | 'consent'`
- `options` (optional): JSON configuration parameters.

**Example:**
```json
{
  "action": "status"
}
```
```

**Step 4: Run pre-commit verification**

Run: `cd mcp-server && npm run verify:precommit`
Expected:
- TypeScript compilation check passed.
- 0 parameter schema gaps.
- 0 action drift problems.
- All Pre-Commit Checks Passed Successfully.

**Step 5: Commit**

```bash
git add mcp-server/dashboard/js/04-playground-form.js mcp-server/dashboard/index.html mcp-server/docs/skill/references/reverse_tool.md mcp-server/docs/skill/SKILL.md
git commit -m "docs(reverse): add reverse_tool playground, quickstart table, and reference docs"
```

---

### Task 7: Comprehensive Threat-Model and End-to-End Test Suite

**Files:**
- Create: `mcp-server/tests/reverse-threat-model.test.ts`

**Step 1: Write threat-model security tests**

Create `mcp-server/tests/reverse-threat-model.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { sanitizeText } from '../src/reverse/sanitize.js';
import { reaMcpArgs, ReaProxy, ProxyError } from '../src/reverse/proxy.js';
import { checkNodeCompatibility, reverseTool } from '../src/tools/reverse-tool.js';

describe('Threat Model & Security Boundary Auditing', () => {
  it('prevents prompt injection via bidi and zero-width payload in engine output', () => {
    const malicious = 'Normal output \u202Ereversed \u200Bhidden \u001b[31minjected\u001b[0m instruction';
    const sanitized = sanitizeText(malicious);
    expect(sanitized.flags).toContain('bidi');
    expect(sanitized.flags).toContain('zero_width');
    expect(sanitized.flags).toContain('control_chars');
    expect(sanitized.text).toBe('Normal output reversed hidden injected instruction');
  });

  it('enforces Node.js version boundary (rejects 23 and 25)', () => {
    expect(checkNodeCompatibility('22.19.0').supported).toBe(true);
    expect(checkNodeCompatibility('22.18.0').supported).toBe(false);
    expect(checkNodeCompatibility('23.1.0').supported).toBe(false);
    expect(checkNodeCompatibility('25.0.0').supported).toBe(false);
    expect(checkNodeCompatibility('24.0.0').supported).toBe(true);
  });

  it('guarantees forbidden argument patterns throw immediately', () => {
    const dangerous = ['setup', '--http', 'run-setup', 'proxy--http', 'mcp --http'];
    for (const arg of dangerous) {
      expect(() => reaMcpArgs('/usr/bin/rea', [arg])).toThrow(Error);
    }
  });

  it('requires explicit authorization framing when inspecting external targets', async () => {
    const resWithoutAuth = await reverseTool({
      action: 'list_capabilities',
      target: '/opt/suspicious/payload.bin',
    });
    expect(resWithoutAuth.success).toBe(false);
    expect(resWithoutAuth.error).toMatch(/authorization framing/);

    const resWithAuth = await reverseTool({
      action: 'list_capabilities',
      target: '/opt/suspicious/payload.bin',
      authorization: 'lab',
    });
    expect(resWithAuth.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `cd mcp-server && npx vitest run tests/reverse-threat-model.test.ts`
Expected: PASS

**Step 3: Run complete verification suite**

Run:
```bash
cd mcp-server
npx vitest run tests/reverse-*.test.ts
npx tsx scripts/smoke/reverse_proxy_smoke.ts
npm run verify:precommit
```
Expected: All test suites PASS, smoke challenge outputs 16/16 passed, and pre-commit checks pass with 0 errors.

**Step 4: Commit**

```bash
git add mcp-server/tests/reverse-threat-model.test.ts
git commit -m "test(reverse): add threat-model containment and sandbox security test suite"
```
