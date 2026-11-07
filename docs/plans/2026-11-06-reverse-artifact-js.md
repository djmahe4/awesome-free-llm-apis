# Reverse Artifact & JavaScript Analysis Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Phase 2 (`feat/reverse-artifact-js`) from `docs/plans/rev_tool.md` (and `docs/plans/rev_tool.v1-original.md`): add `analyze_javascript`, `analyze_artifact`, and `get_evidence` actions to `reverse_tool`, backed by strict workspace path confinement, long-lived target sessions (`ReaSessionManager`), dual-mode execution (REA proxy passthrough with robust native AST/binary fallback), structured Evidence Contract output, and full MCP server + frontend dashboard integration.

**Architecture:** Target paths are strictly validated through a path-safety confinement engine (verifying canonicalization within the workspace, rejecting symlinks, directory traversal, and oversized targets). Requests are routed to long-lived session-managed `ReaProxy` instances when `REA_AGENTS_PATH` is configured, or to built-in zero-dependency native analyzers (JavaScript AST/route/sink/secret extractor and binary magic-byte/entropy/string extractor). Output conforms to the full Evidence Contract (`evidence_id`, `normalized_result`, `analysis_profile`, `coverage`, `limitations`, `list_unknowns`, `provenance: { source, sha256, tool, trusted: false }`), which is retained in an evidence store and exposed natively via the MCP protocol and web dashboard playground.

**Tech Stack:** TypeScript (Node 22+ LTS ESM), Node.js `fs` / `path` / `crypto`, `@modelcontextprotocol/sdk`, Express, `vitest`, and project verification utilities (`sanitizeText`, `showfor-claims`, `dashboard-showfor-hypotheses`).

---

### Task 1: Path Safety, Confinement, and Threat Model Verification

> **Note on `mcp-home.ts` vs `path-safety.ts`:**
> `src/utils/mcp-home.ts` provides **server-state home isolation** (`getMcpHome()`, `getMcpDir()`, `sanitizeSessionId()`), ensuring tests and server components write logs and cache strictly into `.free-llm-mcp` without polluting `~`.
> In contrast, `path-safety.ts` provides **target artifact confinement** for incoming caller parameters (`target: string`). It enforces the threat model in `rev_tool.md` (Sections 2 & 6: "path-safety table: traversal, symlink, wrong suffix, oversize") to prevent an untrusted caller or model from pointing `analyze_javascript` or `analyze_artifact` at sensitive system files (e.g., `/etc/passwd`, `~/.ssh/id_rsa`), following malicious symlinks, or supplying 1GB binary targets that crash the server. `path-safety.ts` integrates with `getMcpHome()` / `getMcpDir()` for fallback workspace roots and evidence caching.

**Files:**
- Create: `mcp-server/src/reverse/path-safety.ts`
- Test: `mcp-server/tests/reverse-path-safety.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-path-safety.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { validateSafePath, PathSafetyError } from '../src/reverse/path-safety.js';

describe('validateSafePath Confinement & Safety', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-test-')));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('allows valid existing file inside workspace', () => {
    const filePath = path.join(tmpWorkspace, 'sample.js');
    fs.writeFileSync(filePath, 'console.log("hello");', 'utf-8');

    const result = validateSafePath(filePath, { workspaceRoot: tmpWorkspace });
    expect(result.safe).toBe(true);
    expect(result.canonicalPath).toBe(path.resolve(filePath));
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('resolves relative path within workspace', () => {
    const filePath = path.join(tmpWorkspace, 'sub', 'app.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const x = 1;', 'utf-8');

    const result = validateSafePath('sub/app.ts', { workspaceRoot: tmpWorkspace });
    expect(result.safe).toBe(true);
    expect(result.canonicalPath).toBe(path.resolve(filePath));
  });

  it('rejects directory traversal escaping workspace', () => {
    expect(() => {
      validateSafePath('../../../etc/passwd', { workspaceRoot: tmpWorkspace });
    }).toThrow(PathSafetyError);

    try {
      validateSafePath('../../../etc/passwd', { workspaceRoot: tmpWorkspace });
    } catch (e: any) {
      expect(e.code).toBe('traversal');
      expect(e.message).toContain('escapes workspace root');
    }
  });

  it('rejects non-existent targets', () => {
    const missing = path.join(tmpWorkspace, 'does-not-exist.js');
    try {
      validateSafePath(missing, { workspaceRoot: tmpWorkspace });
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('not_found');
    }
  });

  it('rejects symlinks pointing inside or outside workspace when allowSymlinks is false', () => {
    const targetFile = path.join(tmpWorkspace, 'target.js');
    fs.writeFileSync(targetFile, 'content', 'utf-8');
    const symlinkPath = path.join(tmpWorkspace, 'link.js');
    try {
      fs.symlinkSync(targetFile, symlinkPath);
    } catch {
      // Skip symlink creation if OS privileges disallow (e.g. non-admin Windows)
      return;
    }

    try {
      validateSafePath(symlinkPath, { workspaceRoot: tmpWorkspace, allowSymlinks: false });
      expect.fail('Should have rejected symlink');
    } catch (e: any) {
      expect(e.code).toBe('symlink');
      expect(e.message).toContain('Symlinks are not allowed');
    }
  });

  it('enforces maximum allowed file size', () => {
    const bigFile = path.join(tmpWorkspace, 'large.bin');
    fs.writeFileSync(bigFile, Buffer.alloc(1024 * 1024)); // 1MB

    try {
      validateSafePath(bigFile, { workspaceRoot: tmpWorkspace, maxSizeBytes: 512 * 1024 }); // 512KB cap
      expect.fail('Should have rejected oversize file');
    } catch (e: any) {
      expect(e.code).toBe('oversize');
      expect(e.message).toContain('exceeds maximum allowed size');
    }
  });

  it('enforces allowed file extensions when specified', () => {
    const wrongExt = path.join(tmpWorkspace, 'notes.txt');
    fs.writeFileSync(wrongExt, 'text', 'utf-8');

    try {
      validateSafePath(wrongExt, {
        workspaceRoot: tmpWorkspace,
        allowedExtensions: ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'],
      });
      expect.fail('Should have rejected invalid extension');
    } catch (e: any) {
      expect(e.code).toBe('invalid_extension');
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-path-safety.test.ts`
Expected: FAIL with "Cannot find module '../src/reverse/path-safety.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/reverse/path-safety.ts`:
```typescript
import path from 'node:path';
import fs from 'node:fs';
import { getMcpHome } from '../utils/mcp-home.js';

export type PathSafetyErrorCode =
  | 'traversal'
  | 'not_found'
  | 'symlink'
  | 'oversize'
  | 'invalid_extension'
  | 'is_directory';

export class PathSafetyError extends Error {
  public readonly code: PathSafetyErrorCode;

  constructor(message: string, code: PathSafetyErrorCode) {
    super(message);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

export interface PathSafetyOptions {
  workspaceRoot?: string;
  allowedExtensions?: string[];
  maxSizeBytes?: number;
  allowSymlinks?: boolean;
}

export interface SafePathResult {
  safe: boolean;
  canonicalPath: string;
  relativePath: string;
  sizeBytes: number;
  extension: string;
}

/**
 * Validates that targetPath is confined within the allowed workspaceRoot,
 * is not a symlink (unless explicitly allowed), exists, does not exceed size limits,
 * and matches allowed extension rules. Integrates with getMcpHome() for home isolation.
 */
export function validateSafePath(targetPath: string, options: PathSafetyOptions = {}): SafePathResult {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new PathSafetyError('Target path cannot be empty', 'not_found');
  }

  let defaultRoot = process.cwd();
  if (!options.workspaceRoot) {
    try {
      defaultRoot = process.cwd();
    } catch {
      try { defaultRoot = getMcpHome(); } catch {}
    }
  }

  const workspaceRoot = path.resolve(options.workspaceRoot || defaultRoot);
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(workspaceRoot, targetPath);

  // 1. Boundary & Directory Traversal Check
  const relative = path.relative(workspaceRoot, resolvedPath);
  const escapes = relative.startsWith('..') || path.isAbsolute(relative);
  if (escapes) {
    throw new PathSafetyError(
      `Target path "${targetPath}" escapes workspace root "${workspaceRoot}"`,
      'traversal'
    );
  }

  // 2. Existence & Symlink Check
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolvedPath);
  } catch {
    throw new PathSafetyError(`Target file "${targetPath}" does not exist`, 'not_found');
  }

  if (lstat.isSymbolicLink() && options.allowSymlinks !== true) {
    throw new PathSafetyError(
      `Symlinks are not allowed for security containment: "${targetPath}"`,
      'symlink'
    );
  }

  if (lstat.isDirectory()) {
    throw new PathSafetyError(`Target "${targetPath}" is a directory, not a file`, 'is_directory');
  }

  // 3. Extension Check
  const ext = path.extname(resolvedPath).toLowerCase();
  if (options.allowedExtensions && options.allowedExtensions.length > 0) {
    const normalizedAllowed = options.allowedExtensions.map((e) => e.toLowerCase());
    if (!normalizedAllowed.includes(ext)) {
      throw new PathSafetyError(
        `File extension "${ext}" is not permitted. Allowed: ${normalizedAllowed.join(', ')}`,
        'invalid_extension'
      );
    }
  }

  // 4. File Size Cap
  const maxBytes = options.maxSizeBytes ?? 50 * 1024 * 1024; // Default 50MB
  if (lstat.size > maxBytes) {
    throw new PathSafetyError(
      `File size (${lstat.size} bytes) exceeds maximum allowed size (${maxBytes} bytes)`,
      'oversize'
    );
  }

  return {
    safe: true,
    canonicalPath: resolvedPath,
    relativePath: relative,
    sizeBytes: lstat.size,
    extension: ext,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-path-safety.test.ts`
Expected: PASS (7/7 tests passed).

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/path-safety.ts mcp-server/tests/reverse-path-safety.test.ts
git commit -m "feat(reverse): add path confinement and safety validation engine" -m "Problem: Malicious or unvalidated target paths could permit directory traversal escaping the workspace, symlink redirection to host secrets, or memory exhaustion through gigantic targets." -m "Implementation & Verification: Implemented validateSafePath() enforcing canonical root boundaries, lstat symlink rejection, extension allowlisting, and size caps. Verified with comprehensive unit test suite in reverse-path-safety.test.ts."
```

---

### Task 2: Evidence Contract Types, Normalization & Provenance Stamping

**Files:**
- Create: `mcp-server/src/reverse/evidence.ts`
- Test: `mcp-server/tests/reverse-evidence.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-evidence.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  createEvidenceBundle,
  normalizeEvidence,
  storeEvidence,
  getStoredEvidence,
  type ReverseEvidence,
} from '../src/reverse/evidence.js';

describe('Evidence Contract & Provenance', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates structured evidence conforming to the REA specification', () => {
    const rawResult = {
      routes: ['/api/v1/users', '/api/v1/health'],
      sinks: ['eval'],
    };

    const bundle = createEvidenceBundle({
      tool: 'analyze_javascript',
      source: 'javascript_ast',
      target: '/workspace/app.js',
      normalizedResult: rawResult,
      analysisProfile: { language: 'javascript', lines: 120, sizeBytes: 3400 },
      coverage: { scope: 'file', status: 'complete' },
      limitations: ['Dynamic imports unparsed'],
      unknowns: ['unresolved_runtime_config'],
      observations: [{ routesCount: 2 }],
      derivations: [{ detectedSinks: ['eval'] }],
    });

    expect(bundle.evidence_id).toMatch(/^ev-[a-f0-9]{16}$/);
    expect(bundle.normalized_result).toEqual(rawResult);
    expect(bundle.analysis_profile.language).toBe('javascript');
    expect(bundle.coverage.status).toBe('complete');
    expect(bundle.limitations).toContain('Dynamic imports unparsed');
    expect(bundle.list_unknowns).toContain('unresolved_runtime_config');
    expect(bundle.observations).toHaveLength(1);
    expect(bundle.derivations).toHaveLength(1);
    expect(bundle.provenance.trusted).toBe(false);
    expect(bundle.provenance.tool).toBe('analyze_javascript');
    expect(bundle.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normalizes unshaped or raw engine JSON into the Evidence Contract', () => {
    const raw = {
      evidence_id: 'ev-custom-1',
      normalized_result: { files: 3 },
      limitations: ['timeout reached'],
    };

    const normalized = normalizeEvidence(raw, { tool: 'inspect_artifact', target: 'bundle.asar' });
    expect(normalized.evidence_id).toBe('ev-custom-1');
    expect(normalized.normalized_result).toEqual({ files: 3 });
    expect(normalized.limitations).toContain('timeout reached');
    expect(normalized.provenance.trusted).toBe(false);
    expect(normalized.provenance.source).toBe('rea-mcp');
  });

  it('persists and retrieves evidence bundles by ID', () => {
    const bundle = createEvidenceBundle({
      tool: 'inspect_artifact',
      source: 'binary_analyzer',
      target: 'sample.wasm',
      normalizedResult: { magic: 'WASM' },
    });

    storeEvidence(bundle, tmpDir);

    const retrieved = getStoredEvidence(bundle.evidence_id, tmpDir);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.evidence_id).toBe(bundle.evidence_id);
    expect(retrieved?.normalized_result).toEqual({ magic: 'WASM' });
  });

  it('returns null when querying non-existent evidence ID', () => {
    const nonExistent = getStoredEvidence('ev-nonexistent', tmpDir);
    expect(nonExistent).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-evidence.test.ts`
Expected: FAIL with "Cannot find module '../src/reverse/evidence.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/reverse/evidence.ts`:
```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMcpDir } from '../utils/mcp-home.js';

export interface EvidenceProvenance {
  source: string;
  sha256: string;
  tool: string;
  trusted: false;
}

export interface AnalysisCoverage {
  scope: 'file' | 'directory' | 'package' | 'binary' | 'stream';
  status: 'complete' | 'partial' | 'unknown';
}

export interface AnalysisProfile {
  language?: string;
  format?: string;
  sizeBytes?: number;
  lines?: number;
  timestamp?: string;
  [key: string]: unknown;
}

export interface ReverseEvidence {
  evidence_id: string;
  normalized_result: Record<string, unknown>;
  analysis_profile: AnalysisProfile;
  coverage: AnalysisCoverage;
  limitations: string[];
  list_unknowns: string[];
  // v1 backwards-compatible fields
  observations: any[];
  derivations: any[];
  inferences: any[];
  residualUnknowns: string[];
  provenance: EvidenceProvenance;
  raw?: unknown;
}

export interface CreateEvidenceParams {
  tool: string;
  source: string;
  target?: string;
  normalizedResult?: Record<string, unknown>;
  analysisProfile?: AnalysisProfile;
  coverage?: AnalysisCoverage;
  limitations?: string[];
  unknowns?: string[];
  observations?: any[];
  derivations?: any[];
  inferences?: any[];
  raw?: unknown;
}

const memoryEvidenceStore = new Map<string, ReverseEvidence>();

export function createEvidenceBundle(params: CreateEvidenceParams): ReverseEvidence {
  const norm = params.normalizedResult || {};
  const rawData = params.raw ?? norm;
  const rawString = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
  const sha256 = crypto.createHash('sha256').update(rawString).digest('hex');
  const evidence_id = `ev-${crypto.randomBytes(8).toString('hex')}`;

  const bundle: ReverseEvidence = {
    evidence_id,
    normalized_result: norm,
    analysis_profile: {
      timestamp: new Date().toISOString(),
      ...params.analysisProfile,
    },
    coverage: params.coverage || { scope: 'file', status: 'complete' },
    limitations: params.limitations || [],
    list_unknowns: params.unknowns || [],
    observations: params.observations || [],
    derivations: params.derivations || [],
    inferences: params.inferences || [],
    residualUnknowns: params.unknowns || [],
    provenance: {
      source: params.source,
      sha256,
      tool: params.tool,
      trusted: false,
    },
    raw: params.raw,
  };

  memoryEvidenceStore.set(evidence_id, bundle);
  return bundle;
}

export function normalizeEvidence(raw: any, meta: { tool: string; target?: string }): ReverseEvidence {
  if (raw && raw.evidence_id && raw.normalized_result && raw.provenance) {
    return raw as ReverseEvidence;
  }

  const evidence_id = raw?.evidence_id || `ev-${crypto.randomBytes(8).toString('hex')}`;
  const norm = raw?.normalized_result || (typeof raw === 'object' && raw !== null ? raw : { raw });
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(raw ?? {})).digest('hex');

  const bundle: ReverseEvidence = {
    evidence_id,
    normalized_result: norm,
    analysis_profile: raw?.analysis_profile || { timestamp: new Date().toISOString() },
    coverage: raw?.coverage || { scope: 'file', status: 'complete' },
    limitations: raw?.limitations || [],
    list_unknowns: raw?.list_unknowns || raw?.residualUnknowns || [],
    observations: raw?.observations || [],
    derivations: raw?.derivations || [],
    inferences: raw?.inferences || [],
    residualUnknowns: raw?.residualUnknowns || raw?.list_unknowns || [],
    provenance: {
      source: raw?.provenance?.source || 'rea-mcp',
      sha256: raw?.provenance?.sha256 || sha256,
      tool: meta.tool,
      trusted: false,
    },
    raw,
  };

  memoryEvidenceStore.set(evidence_id, bundle);
  return bundle;
}

export function storeEvidence(bundle: ReverseEvidence, dirPath?: string): void {
  memoryEvidenceStore.set(bundle.evidence_id, bundle);
  const targetDir = dirPath || (process.env.VITEST ? undefined : path.join(getMcpDir(), 'reverse', 'evidence'));
  if (targetDir) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, `${bundle.evidence_id}.json`);
      fs.writeFileSync(targetFile, JSON.stringify(bundle, null, 2), 'utf-8');
    } catch {
      // Ignore disk write errors, in-memory store remains primary
    }
  }
}

export function getStoredEvidence(evidenceId: string, dirPath?: string): ReverseEvidence | null {
  if (memoryEvidenceStore.has(evidenceId)) {
    return memoryEvidenceStore.get(evidenceId)!;
  }
  const targetDir = dirPath || (process.env.VITEST ? undefined : path.join(getMcpDir(), 'reverse', 'evidence'));
  if (targetDir) {
    const targetFile = path.join(targetDir, `${evidenceId}.json`);
    if (fs.existsSync(targetFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
        memoryEvidenceStore.set(evidenceId, parsed);
        return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-evidence.test.ts`
Expected: PASS (4/4 tests passed).

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/evidence.ts mcp-server/tests/reverse-evidence.test.ts
git commit -m "feat(reverse): implement Evidence Contract and provenance model" -m "Problem: The threat model requires all reverse analysis output to carry untrusted provenance tags and uniform Evidence Contract schemas (evidence_id, normalized_result, coverage, unknowns) across engines." -m "Implementation & Verification: Created evidence bundle factory, normalizer, and dual memory/disk retention store. Verified contract shape and provenance tagging with unit tests in reverse-evidence.test.ts."
```

---

### Task 3: Long-Lived Proxy Session Manager

**Files:**
- Create: `mcp-server/src/reverse/session-manager.ts`
- Test: `mcp-server/tests/reverse-session-manager.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-session-manager.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReaSessionManager } from '../src/reverse/session-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_REA = path.join(here, '..', 'scripts', 'smoke', 'fixtures', 'fake-rea.mjs');

describe('ReaSessionManager Lifecycle', () => {
  let manager: ReaSessionManager;

  beforeEach(() => {
    manager = new ReaSessionManager({
      idleTimeoutMs: 2000,
      command: process.execPath,
      args: [FAKE_REA],
    });
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  it('creates and caches session per target key', async () => {
    const proxy1 = await manager.getOrCreateSession('target-a');
    const proxy2 = await manager.getOrCreateSession('target-a');
    expect(proxy1).toBe(proxy2);
    expect(proxy1.callable).toContain('inspect_artifact');
  });

  it('creates distinct sessions for different targets', async () => {
    const proxyA = await manager.getOrCreateSession('target-a');
    const proxyB = await manager.getOrCreateSession('target-b');
    expect(proxyA).not.toBe(proxyB);
  });

  it('closes specific session cleanly', async () => {
    const proxyA = await manager.getOrCreateSession('target-a');
    expect(manager.hasSession('target-a')).toBe(true);
    await manager.closeSession('target-a');
    expect(manager.hasSession('target-a')).toBe(false);
  });

  it('closes all sessions cleanly on shutdown', async () => {
    await manager.getOrCreateSession('target-1');
    await manager.getOrCreateSession('target-2');
    expect(manager.size).toBe(2);
    await manager.closeAll();
    expect(manager.size).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-session-manager.test.ts`
Expected: FAIL with "Cannot find module '../src/reverse/session-manager.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/reverse/session-manager.ts`:
```typescript
import { ReaProxy, type ReaProxyOptions } from './proxy.js';

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ActiveSession {
  proxy: ReaProxy;
  lastUsed: number;
  timer: NodeJS.Timeout | null;
}

export class ReaSessionManager {
  private sessions = new Map<string, ActiveSession>();
  private readonly defaultCommand: string;
  private readonly defaultArgs: string[];
  private readonly defaultEnv?: Record<string, string>;
  private readonly idleTimeoutMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.defaultCommand = options.command || process.env.REA_AGENTS_PATH || 'rea';
    this.defaultArgs = options.args || [];
    this.defaultEnv = options.env;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000; // 5 min idle default
  }

  public get size(): number {
    return this.sessions.size;
  }

  public hasSession(key: string): boolean {
    return this.sessions.has(key);
  }

  private resetIdleTimer(key: string, session: ActiveSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
    }
    session.timer = setTimeout(async () => {
      await this.closeSession(key);
    }, this.idleTimeoutMs);
  }

  public async getOrCreateSession(key: string, overrideOptions?: Partial<ReaProxyOptions>): Promise<ReaProxy> {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      this.resetIdleTimer(key, existing);
      return existing.proxy;
    }

    const proxy = new ReaProxy({
      command: overrideOptions?.command || this.defaultCommand,
      args: overrideOptions?.args || this.defaultArgs,
      env: overrideOptions?.env || this.defaultEnv,
      requestTimeoutMs: overrideOptions?.requestTimeoutMs,
      handshakeTimeoutMs: overrideOptions?.handshakeTimeoutMs,
      maxResponseBytes: overrideOptions?.maxResponseBytes,
      pins: overrideOptions?.pins,
    });

    await proxy.start();

    const session: ActiveSession = {
      proxy,
      lastUsed: Date.now(),
      timer: null,
    };

    this.resetIdleTimer(key, session);
    this.sessions.set(key, session);
    return proxy;
  }

  public async closeSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    if (session.timer) {
      clearTimeout(session.timer);
    }
    await session.proxy.close();
  }

  public async closeAll(): Promise<void> {
    const keys = [...this.sessions.keys()];
    await Promise.all(keys.map((k) => this.closeSession(k)));
  }
}

// Global default singleton session manager
export const defaultSessionManager = new ReaSessionManager();
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-session-manager.test.ts`
Expected: PASS (4/4 tests passed).

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/session-manager.ts mcp-server/tests/reverse-session-manager.test.ts
git commit -m "feat(reverse): add ReaSessionManager for long-lived target proxy sessions" -m "Problem: Spec section 2 requires one long-lived proxy session per target to ensure retained evidence handles stay valid without spawning expensive processes on every call." -m "Implementation & Verification: Built ReaSessionManager with idle timeout eviction, per-target proxy pooling, and clean shutdown. Verified with unit tests in reverse-session-manager.test.ts."
```

---

### Task 4: JavaScript & TypeScript Application Analysis Engine

**Files:**
- Create: `mcp-server/src/reverse/js-analyzer.ts`
- Test: `mcp-server/tests/reverse-js-analyzer.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-js-analyzer.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { analyzeJavaScriptFile } from '../src/reverse/js-analyzer.js';

describe('analyzeJavaScriptFile Static & Proxy Analyzer', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'js-analyzer-test-')));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('extracts express routes, dangerous sinks, imports, and exports from JavaScript', async () => {
    const code = `
      import express from 'express';
      import { exec } from 'child_process';
      const router = express.Router();

      router.get('/api/v1/status', (req, res) => res.json({ ok: true }));
      router.post('/api/v1/run', (req, res) => {
        eval(req.body.code);
        exec(req.body.cmd);
      });

      export default router;
    `;
    const targetFile = path.join(tmpWorkspace, 'routes.js');
    fs.writeFileSync(targetFile, code, 'utf-8');

    const evidence = await analyzeJavaScriptFile(targetFile, { workspaceRoot: tmpWorkspace });

    expect(evidence.evidence_id).toMatch(/^ev-/);
    expect(evidence.coverage.status).toBe('complete');
    expect(evidence.analysis_profile.language).toBe('javascript');

    const norm: any = evidence.normalized_result;
    expect(norm.routes).toContain('GET /api/v1/status');
    expect(norm.routes).toContain('POST /api/v1/run');
    expect(norm.sinks).toContain('eval');
    expect(norm.sinks).toContain('exec');
    expect(norm.imports).toContain('express');
    expect(norm.imports).toContain('child_process');
    expect(norm.exports).toContain('default');
    expect(evidence.provenance.trusted).toBe(false);
  });

  it('detects exposed hardcoded API secrets or tokens', async () => {
    const code = `
      const JWT_SECRET = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";
      const API_KEY = "sk-live-1234567890abcdef1234567890abcdef";
    `;
    const targetFile = path.join(tmpWorkspace, 'config.js');
    fs.writeFileSync(targetFile, code, 'utf-8');

    const evidence = await analyzeJavaScriptFile(targetFile, { workspaceRoot: tmpWorkspace });
    const norm: any = evidence.normalized_result;
    expect(norm.secretsFound).toBe(true);
    expect(norm.secrets.length).toBeGreaterThan(0);
    expect(norm.secrets.some((s: any) => s.type === 'jwt' || s.type === 'api_key')).toBe(true);
  });

  it('handles empty files gracefully without throwing', async () => {
    const targetFile = path.join(tmpWorkspace, 'empty.js');
    fs.writeFileSync(targetFile, '', 'utf-8');

    const evidence = await analyzeJavaScriptFile(targetFile, { workspaceRoot: tmpWorkspace });
    expect(evidence.coverage.status).toBe('complete');
    expect((evidence.normalized_result as any).routes).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-js-analyzer.test.ts`
Expected: FAIL with "Cannot find module '../src/reverse/js-analyzer.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/reverse/js-analyzer.ts`:
```typescript
import fs from 'node:fs';
import path from 'node:path';
import { validateSafePath, type PathSafetyOptions } from './path-safety.js';
import { createEvidenceBundle, type ReverseEvidence } from './evidence.js';
import { defaultSessionManager } from './session-manager.js';

export interface JsAnalyzerOptions extends PathSafetyOptions {
  reaAgentsPath?: string;
  filterPath?: string;
}

export async function analyzeJavaScriptFile(
  targetPath: string,
  options: JsAnalyzerOptions = {}
): Promise<ReverseEvidence> {
  const safe = validateSafePath(targetPath, {
    ...options,
    allowedExtensions: options.allowedExtensions || ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'],
  });

  const reaPath = options.reaAgentsPath || process.env.REA_AGENTS_PATH;

  // Option A: Active REA Proxy Passthrough
  if (reaPath) {
    try {
      const proxy = await defaultSessionManager.getOrCreateSession(safe.canonicalPath, {
        command: reaPath,
      });
      if (proxy.callable.includes('analyze_javascript_application')) {
        const result = await proxy.call('analyze_javascript_application', {
          path: safe.canonicalPath,
          filter: options.filterPath,
        });
        return createEvidenceBundle({
          tool: 'analyze_javascript',
          source: 'rea-mcp:analyze_javascript_application',
          target: safe.canonicalPath,
          normalizedResult: result.raw || { text: result.text },
          analysisProfile: {
            language: safe.extension === '.ts' || safe.extension === '.tsx' ? 'typescript' : 'javascript',
            sizeBytes: safe.sizeBytes,
          },
          coverage: { scope: 'file', status: 'complete' },
          raw: result.raw,
        });
      }
    } catch {
      // Degrade gracefully to built-in native static analyzer
    }
  }

  // Option B: Native High-Performance Static Analyzer
  const content = fs.readFileSync(safe.canonicalPath, 'utf-8');
  const lines = content.split('\n');

  const routes: string[] = [];
  const sinks: string[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const secrets: Array<{ type: string; line: number }> = [];

  // 1. Route extraction regexes
  const routeRegex = /(?:router|app)\.(get|post|put|delete|patch|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(content)) !== null) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  }

  // 2. Dangerous sinks regexes
  const sinkPatterns = [
    { name: 'eval', regex: /\beval\s*\(/g },
    { name: 'Function', regex: /\bnew\s+Function\s*\(/g },
    { name: 'exec', regex: /\bexec(?:Sync)?\s*\(/g },
    { name: 'spawn', regex: /\bspawn(?:Sync)?\s*\(/g },
    { name: 'vm.runInContext', regex: /\bvm\.(?:runInContext|runInNewContext|runInThisContext)\s*\(/g },
    { name: 'dangerouslySetInnerHTML', regex: /dangerouslySetInnerHTML/g },
  ];
  for (const { name, regex } of sinkPatterns) {
    if (regex.test(content)) {
      sinks.push(name);
    }
  }

  // 3. Imports and dependencies
  const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\))/g;
  while ((match = importRegex.exec(content)) !== null) {
    const pkg = match[1] || match[2];
    if (pkg && !imports.includes(pkg)) imports.push(pkg);
  }

  // 4. Exports
  const exportRegex = /export\s+(?:default\s+)?(?:const|let|var|function|class)?\s*([a-zA-Z0-9_$]+)?/g;
  while ((match = exportRegex.exec(content)) !== null) {
    const exp = match[0].includes('default') ? 'default' : match[1];
    if (exp && !exports.includes(exp)) exports.push(exp);
  }

  // 5. Secret detection
  const jwtRegex = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/;
  const apiKeyRegex = /['"`](?:sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{35}|ghp_[a-zA-Z0-9]{36})['"`]/;
  lines.forEach((lineText, idx) => {
    if (jwtRegex.test(lineText)) secrets.push({ type: 'jwt', line: idx + 1 });
    if (apiKeyRegex.test(lineText)) secrets.push({ type: 'api_key', line: idx + 1 });
  });

  return createEvidenceBundle({
    tool: 'analyze_javascript',
    source: 'javascript_ast_static',
    target: safe.canonicalPath,
    normalizedResult: {
      routes,
      sinks,
      imports,
      exports,
      secretsFound: secrets.length > 0,
      secrets,
    },
    analysisProfile: {
      language: safe.extension === '.ts' || safe.extension === '.tsx' ? 'typescript' : 'javascript',
      lines: lines.length,
      sizeBytes: safe.sizeBytes,
    },
    coverage: { scope: 'file', status: 'complete' },
    limitations: [],
    unknowns: [],
    observations: [
      { routesCount: routes.length, sinksCount: sinks.length, importsCount: imports.length },
    ],
    derivations: [
      { routes, sinks },
    ],
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-js-analyzer.test.ts`
Expected: PASS (3/3 tests passed).

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/js-analyzer.ts mcp-server/tests/reverse-js-analyzer.test.ts
git commit -m "feat(reverse): add JavaScript/TypeScript AST and route/sink static analyzer" -m "Problem: Reverse engineering web/Node targets requires extracting route definitions, dangerous sinks (eval/exec), imported modules, and exposed API keys without relying solely on external tools." -m "Implementation & Verification: Implemented analyzeJavaScriptFile() with REA proxy passthrough and zero-dependency static fallback. Verified route, sink, import, and secret extraction in reverse-js-analyzer.test.ts."
```

---

### Task 5: Artifact Inspection, Binary Magic-Bytes & Shannon Entropy Analyzer

**Files:**
- Create: `mcp-server/src/reverse/artifact-analyzer.ts`
- Test: `mcp-server/tests/reverse-artifact-analyzer.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-artifact-analyzer.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { analyzeArtifactFile, calculateEntropy } from '../src/reverse/artifact-analyzer.js';

describe('analyzeArtifactFile Magic-Byte & Entropy Analyzer', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-analyzer-test-')));
  });

  afterEach(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('accurately identifies ELF binary magic bytes', async () => {
    const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const targetFile = path.join(tmpWorkspace, 'sample.elf');
    fs.writeFileSync(targetFile, elfHeader);

    const evidence = await analyzeArtifactFile(targetFile, { workspaceRoot: tmpWorkspace });
    const norm: any = evidence.normalized_result;
    expect(norm.format).toBe('ELF');
    expect(norm.mimeType).toBe('application/x-executable');
  });

  it('accurately identifies WebAssembly WASM magic bytes', async () => {
    const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const targetFile = path.join(tmpWorkspace, 'module.wasm');
    fs.writeFileSync(targetFile, wasmHeader);

    const evidence = await analyzeArtifactFile(targetFile, { workspaceRoot: tmpWorkspace });
    const norm: any = evidence.normalized_result;
    expect(norm.format).toBe('WASM');
    expect(norm.mimeType).toBe('application/wasm');
  });

  it('accurately computes Shannon entropy for zero vs random bytes', () => {
    const zeroBytes = Buffer.alloc(1024, 0);
    expect(calculateEntropy(zeroBytes)).toBe(0);

    // Random bytes have entropy approaching 8 bits per byte
    const randomBytes = Buffer.alloc(4096);
    for (let i = 0; i < randomBytes.length; i++) randomBytes[i] = Math.floor(Math.random() * 256);
    const entropy = calculateEntropy(randomBytes);
    expect(entropy).toBeGreaterThan(7.0);
  });

  it('extracts printable ASCII string tables from artifact', async () => {
    const buffer = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from('HelloReverseEngineering'),
      Buffer.from([0x00, 0xff]),
      Buffer.from('https://api.example.com/endpoint'),
    ]);
    const targetFile = path.join(tmpWorkspace, 'data.bin');
    fs.writeFileSync(targetFile, buffer);

    const evidence = await analyzeArtifactFile(targetFile, { workspaceRoot: tmpWorkspace });
    const norm: any = evidence.normalized_result;
    expect(norm.strings).toContain('HelloReverseEngineering');
    expect(norm.strings).toContain('https://api.example.com/endpoint');
    expect(norm.urls).toContain('https://api.example.com/endpoint');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-artifact-analyzer.test.ts`
Expected: FAIL with "Cannot find module '../src/reverse/artifact-analyzer.js'"

**Step 3: Write minimal implementation**

Create `mcp-server/src/reverse/artifact-analyzer.ts`:
```typescript
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateSafePath, type PathSafetyOptions } from './path-safety.js';
import { createEvidenceBundle, type ReverseEvidence } from './evidence.js';
import { defaultSessionManager } from './session-manager.js';

export interface ArtifactAnalyzerOptions extends PathSafetyOptions {
  reaAgentsPath?: string;
  maxStrings?: number;
}

export function calculateEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const freq = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) {
    freq[buf[i]]++;
  }
  let entropy = 0;
  const len = buf.length;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / len;
      entropy -= p * Math.log2(p);
    }
  }
  return Number(entropy.toFixed(4));
}

export function detectMagicFormat(header: Buffer): { format: string; mimeType: string } {
  if (header.length >= 4) {
    if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
      return { format: 'ELF', mimeType: 'application/x-executable' };
    }
    if (header[0] === 0x4d && header[1] === 0x5a) {
      return { format: 'PE/Windows Executable', mimeType: 'application/vnd.microsoft.portable-executable' };
    }
    if (
      (header[0] === 0xfe && header[1] === 0xed && header[2] === 0xfa && (header[3] === 0xce || header[3] === 0xcf)) ||
      (header[0] === 0xcf && header[1] === 0xfa && header[2] === 0xed && header[3] === 0xfe)
    ) {
      return { format: 'Mach-O', mimeType: 'application/x-mach-binary' };
    }
    if (header[0] === 0x00 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d) {
      return { format: 'WASM', mimeType: 'application/wasm' };
    }
    if (header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
      return { format: 'ZIP/Archive/APK', mimeType: 'application/zip' };
    }
    if (header[0] === 0x47 && header[1] === 0x47 && header[2] === 0x55 && header[3] === 0x46) {
      return { format: 'GGUF', mimeType: 'application/octet-stream' };
    }
    if (header.toString('utf8', 0, 4) === '%PDF') {
      return { format: 'PDF', mimeType: 'application/pdf' };
    }
  }
  return { format: 'Binary/Data', mimeType: 'application/octet-stream' };
}

export function extractStrings(buf: Buffer, minLen = 4, maxStrings = 50): string[] {
  const result: string[] = [];
  let current = '';

  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    // Printable ASCII 32..126
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLen) {
        result.push(current);
        if (result.length >= maxStrings) break;
      }
      current = '';
    }
  }
  if (current.length >= minLen && result.length < maxStrings) {
    result.push(current);
  }
  return result;
}

export async function analyzeArtifactFile(
  targetPath: string,
  options: ArtifactAnalyzerOptions = {}
): Promise<ReverseEvidence> {
  const safe = validateSafePath(targetPath, options);
  const reaPath = options.reaAgentsPath || process.env.REA_AGENTS_PATH;

  // Option A: Active REA Proxy Passthrough
  if (reaPath) {
    try {
      const proxy = await defaultSessionManager.getOrCreateSession(safe.canonicalPath, {
        command: reaPath,
      });
      if (proxy.callable.includes('inspect_artifact')) {
        const result = await proxy.call('inspect_artifact', {
          path: safe.canonicalPath,
        });
        return createEvidenceBundle({
          tool: 'analyze_artifact',
          source: 'rea-mcp:inspect_artifact',
          target: safe.canonicalPath,
          normalizedResult: result.raw || { text: result.text },
          coverage: { scope: 'binary', status: 'complete' },
          raw: result.raw,
        });
      }
    } catch {
      // Degrade gracefully to native static analyzer
    }
  }

  // Option B: Native Binary Inspection Fallback
  const buf = fs.readFileSync(safe.canonicalPath);
  const header = buf.subarray(0, 16);
  const { format, mimeType } = detectMagicFormat(header);
  const entropy = calculateEntropy(buf);
  const strings = extractStrings(buf, 4, options.maxStrings ?? 50);

  const urlRegex = /https?:\/\/[^\s$.?#].[^\s]*/gi;
  const urls = strings.filter((s) => urlRegex.test(s));

  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  const isPacked = entropy > 7.2;

  return createEvidenceBundle({
    tool: 'analyze_artifact',
    source: 'artifact_binary_static',
    target: safe.canonicalPath,
    normalizedResult: {
      format,
      mimeType,
      sizeBytes: safe.sizeBytes,
      entropy,
      isPackedOrEncrypted: isPacked,
      hashes: { md5, sha1, sha256 },
      stringsCount: strings.length,
      strings: strings.slice(0, 30),
      urls,
    },
    analysisProfile: {
      format,
      mimeType,
      sizeBytes: safe.sizeBytes,
    },
    coverage: { scope: 'binary', status: 'complete' },
    limitations: isPacked ? ['High entropy detected; sample is likely compressed, packed or encrypted'] : [],
    unknowns: [],
    observations: [
      { format, sizeBytes: safe.sizeBytes, entropy, hashes: { sha256 } },
    ],
    derivations: [
      { urls, sampleStrings: strings.slice(0, 10) },
    ],
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-artifact-analyzer.test.ts`
Expected: PASS (4/4 tests passed).

**Step 5: Commit**

```bash
git add mcp-server/src/reverse/artifact-analyzer.ts mcp-server/tests/reverse-artifact-analyzer.test.ts
git commit -m "feat(reverse): add artifact inspector with magic-bytes, entropy, and string extraction" -m "Problem: Reverse engineering unknown artifacts requires identifying file types, Shannon entropy (detecting packing/encryption), printable strings, and hash digests even when an external decompilation engine is offline." -m "Implementation & Verification: Built detectMagicFormat(), calculateEntropy(), and extractStrings() integrated into analyzeArtifactFile(). Verified with unit tests in reverse-artifact-analyzer.test.ts."
```

---

### Task 6: Wire Actions into `reverseTool` Router and Authorization Framing

**Files:**
- Modify: `mcp-server/src/tools/reverse-tool.ts`
- Test: `mcp-server/tests/reverse-tool-actions.test.ts`

**Step 1: Write the failing test**

Update `mcp-server/tests/reverse-tool-actions.test.ts` to add test cases for `analyze_javascript`, `analyze_artifact`, and `get_evidence`:
```typescript
  it('rejects analyze_javascript when authorization framing is missing', async () => {
    const res = await reverseTool({
      action: 'analyze_javascript',
      target: 'src/index.ts',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Target analysis requires authorization framing: "ctf" | "lab" | "consent"');
  });

  it('rejects analyze_artifact when authorization framing is missing', async () => {
    const res = await reverseTool({
      action: 'analyze_artifact',
      target: 'package.json',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Target analysis requires authorization framing');
  });

  it('executes analyze_javascript successfully with authorization', async () => {
    const res = await reverseTool({
      action: 'analyze_javascript',
      target: 'src/tools/index.ts',
      authorization: 'lab',
    });
    expect(res.success).toBe(true);
    expect(res.evidence).toBeDefined();
    expect(res.evidence.evidence_id).toMatch(/^ev-/);
    expect(res.evidence.provenance.trusted).toBe(false);
  });

  it('executes analyze_artifact successfully with authorization', async () => {
    const res = await reverseTool({
      action: 'analyze_artifact',
      target: 'package.json',
      authorization: 'consent',
    });
    expect(res.success).toBe(true);
    expect(res.evidence).toBeDefined();
    expect(res.evidence.normalized_result.hashes).toBeDefined();
  });

  it('retrieves evidence bundle by evidence_id using get_evidence', async () => {
    const initial = await reverseTool({
      action: 'analyze_artifact',
      target: 'package.json',
      authorization: 'consent',
    });
    const evId = initial.evidence.evidence_id;

    const res = await reverseTool({
      action: 'get_evidence',
      target: evId,
      authorization: 'consent',
    });
    expect(res.success).toBe(true);
    expect(res.data.evidence_id).toBe(evId);
    expect(res.data.provenance.trusted).toBe(false);
  });
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-tool-actions.test.ts`
Expected: FAIL with "Unsupported action: analyze_javascript"

**Step 3: Write minimal implementation**

Update `mcp-server/src/tools/reverse-tool.ts`:
```typescript
import { ReaProxy, type BlockedToolInfo } from '../reverse/proxy.js';
import { analyzeJavaScriptFile } from '../reverse/js-analyzer.js';
import { analyzeArtifactFile } from '../reverse/artifact-analyzer.js';
import { getStoredEvidence, type ReverseEvidence } from '../reverse/evidence.js';

export type ReverseAuthorization = 'ctf' | 'lab' | 'consent';

export interface ReverseToolInput {
  action: 'status' | 'list_capabilities' | 'analyze_javascript' | 'analyze_artifact' | 'get_evidence';
  target?: string;
  authorization?: ReverseAuthorization;
  options?: Record<string, unknown>;
}

export interface ReverseToolResult {
  success: boolean;
  action: string;
  target?: string;
  evidence?: ReverseEvidence;
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
  const { action, target, authorization, options = {} } = input;

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
          'analyze_artifact',
          'get_evidence',
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
      const proxy = new ReaProxy({
        command: reaPath,
        requestTimeoutMs: 5000,
      });
      try {
        const info = await proxy.start();
        engineCallable = info.callable;
        engineBlocked = info.blocked;
      } catch (err: any) {
        engineBlocked.push({ name: 'rea-engine', reason: err.message || 'Failed to initialize engine' });
      } finally {
        await proxy.close();
      }
    }

    const staticCapabilities = [
      'analyze_javascript',
      'analyze_artifact',
      'get_evidence',
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
        staticProviders: ['javascript_ast', 'artifact_binary', 'github_manifest', 'gguf_metadata'],
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

  // Target-requiring actions mandate authorization framing
  if (!authorization) {
    return {
      success: false,
      action,
      target,
      error: 'Target analysis requires authorization framing: "ctf" | "lab" | "consent".',
    };
  }

  if (!target) {
    return {
      success: false,
      action,
      error: `Action "${action}" requires a "target" parameter.`,
    };
  }

  if (action === 'analyze_javascript') {
    try {
      const evidence = await analyzeJavaScriptFile(target, {
        workspaceRoot: options.workspaceRoot as string,
        reaAgentsPath: process.env.REA_AGENTS_PATH,
        filterPath: options.filterPath as string,
      });
      return {
        success: true,
        action: 'analyze_javascript',
        target,
        evidence,
        data: evidence.normalized_result,
      };
    } catch (err: any) {
      return {
        success: false,
        action: 'analyze_javascript',
        target,
        error: err.message || 'JavaScript analysis failed',
      };
    }
  }

  if (action === 'analyze_artifact') {
    try {
      const evidence = await analyzeArtifactFile(target, {
        workspaceRoot: options.workspaceRoot as string,
        reaAgentsPath: process.env.REA_AGENTS_PATH,
        maxStrings: options.maxStrings as number,
      });
      return {
        success: true,
        action: 'analyze_artifact',
        target,
        evidence,
        data: evidence.normalized_result,
      };
    } catch (err: any) {
      return {
        success: false,
        action: 'analyze_artifact',
        target,
        error: err.message || 'Artifact analysis failed',
      };
    }
  }

  if (action === 'get_evidence') {
    const evidence = getStoredEvidence(target);
    if (!evidence) {
      return {
        success: false,
        action: 'get_evidence',
        target,
        error: `No stored evidence found with ID "${target}".`,
      };
    }
    return {
      success: true,
      action: 'get_evidence',
      target,
      evidence,
      data: evidence,
    };
  }

  return {
    success: false,
    action: action || 'unknown',
    error: `Unsupported action: "${action}". Supported: "status", "list_capabilities", "analyze_javascript", "analyze_artifact", "get_evidence".`,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-tool-actions.test.ts`
Expected: PASS (11/11 tests passed).

**Step 5: Commit**

```bash
git add mcp-server/src/tools/reverse-tool.ts mcp-server/tests/reverse-tool-actions.test.ts
git commit -m "feat(reverse): connect analyze_javascript, analyze_artifact, and get_evidence to reverseTool" -m "Problem: The MCP reverseTool router previously supported only status and list_capabilities without handling artifact or JavaScript analysis workflows." -m "Implementation & Verification: Connected analyzeJavaScriptFile, analyzeArtifactFile, and getStoredEvidence to reverseTool with strict authorization framing gating. Verified with unit tests in reverse-tool-actions.test.ts."
```

---

### Task 7: MCP Server Registration, REST API Endpoint, Dashboard Playground, and Documentation

**Files:**
- Modify: `mcp-server/src/mcp/index.ts`
- Modify: `mcp-server/src/server.ts`
- Modify: `mcp-server/dashboard/js/04-playground-form.js`
- Modify: `mcp-server/dashboard/partials/09-quickstart.html`
- Modify: `mcp-server/scripts/verification/showfor-claims.ts`
- Create: `mcp-server/docs/skill/references/reverse_tool.md`
- Test: `mcp-server/tests/reverse-mcp-integration.test.ts`
- Test: `mcp-server/tests/dashboard-showfor-hypotheses.test.ts`

**Step 1: Write the failing test**

Create `mcp-server/tests/reverse-mcp-integration.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { TOOLS } from '../src/mcp/index.js';
import { FIELD_USES } from '../scripts/verification/showfor-claims.js';

describe('reverse_tool MCP Registration & Claims', () => {
  it('registers reverse_tool in the MCP server tools schema', () => {
    const revTool = TOOLS.find((t) => t.name === 'reverse_tool');
    expect(revTool).toBeDefined();
    expect(revTool?.description).toContain('Reverse engineering');

    const schema: any = revTool?.inputSchema;
    expect(schema.properties.action.enum).toContain('status');
    expect(schema.properties.action.enum).toContain('list_capabilities');
    expect(schema.properties.action.enum).toContain('analyze_javascript');
    expect(schema.properties.action.enum).toContain('analyze_artifact');
    expect(schema.properties.action.enum).toContain('get_evidence');
    expect(schema.properties.authorization.enum).toEqual(['ctf', 'lab', 'consent']);
  });

  it('has documented field uses in showfor-claims for playground consistency', () => {
    const revClaims = FIELD_USES.filter((u) => u.tool === 'reverse_tool');
    expect(revClaims.length).toBeGreaterThan(0);
    const targetClaim = revClaims.find((u) => u.field === 'target');
    expect(targetClaim).toBeDefined();
    expect(targetClaim?.actions).toContain('analyze_javascript');
    expect(targetClaim?.actions).toContain('analyze_artifact');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm --prefix mcp-server test -- tests/reverse-mcp-integration.test.ts`
Expected: FAIL with "reverse_tool not found in TOOLS"

**Step 3: Write minimal implementation**

1. In `mcp-server/src/mcp/index.ts`:
   - Add `reverse_tool` declaration to `TOOLS` array:
     ```typescript
     {
       name: 'reverse_tool',
       description: 'Reverse engineering proxy and static analyzer for JavaScript bundles, Electron packages, binary artifacts, and model weights. Enforces authorization framing ("ctf" | "lab" | "consent") on third-party targets, confines paths to the workspace, strips hostile output, and emits structured Evidence Contract bundles with untrusted provenance stamps.',
       inputSchema: {
         type: 'object' as const,
         properties: {
           action: {
             type: 'string',
             enum: ['status', 'list_capabilities', 'analyze_javascript', 'analyze_artifact', 'get_evidence'],
             description: 'Reverse engineering action: "status" (check Node & engine readiness), "list_capabilities" (probe static/native capabilities), "analyze_javascript" (inspect AST/routes/sinks), "analyze_artifact" (inspect magic bytes/entropy/strings), "get_evidence" (retrieve evidence bundle by ID).',
           },
           target: {
             type: 'string',
             description: 'Target file path (for analyze_javascript / analyze_artifact) or evidence_id (for get_evidence).',
           },
           authorization: {
             type: 'string',
             enum: ['ctf', 'lab', 'consent'],
             description: 'Mandatory authorization framing required for any target inspection.',
           },
           options: {
             type: 'object',
             description: 'Optional action-specific flags (workspaceRoot, filterPath, maxStrings).',
           },
         },
         required: ['action'],
       },
     }
     ```
   - In `dispatchToolCall`:
     ```typescript
     } else if (name === 'reverse_tool') {
       const { reverseTool } = await import('../tools/reverse-tool.js');
       const result = await reverseTool(args as any);
       response = {
         content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
         isError: !result.success,
       };
     ```

2. In `mcp-server/src/server.ts`:
   - Add POST endpoint `/api/reverse_tool`:
     ```typescript
     app.post('/api/reverse_tool', express.json({ limit: '10mb' }), async (req, res) => {
       try {
         const { reverseTool } = await import('./tools/reverse-tool.js');
         const result = await reverseTool(req.body);
         res.json(result);
       } catch (err: any) {
         res.status(500).json({ success: false, error: err.message });
       }
     });
     ```

3. In `mcp-server/scripts/verification/showfor-claims.ts`:
   - Add `reverse_tool` claims mapping `target`, `authorization`, and `options` to actions.

4. In `mcp-server/dashboard/js/04-playground-form.js`:
   - Add `reverse_tool` definition to `TOOLS` array with action fields and `showFor` filters.

5. In `mcp-server/dashboard/partials/09-quickstart.html`:
   - Add `reverse_tool` table row with curl command example.

6. Create reference docs in `mcp-server/docs/skill/references/reverse_tool.md`.

**Step 4: Run test to verify it passes**

Run: `npm --prefix mcp-server test -- tests/reverse-mcp-integration.test.ts tests/dashboard-showfor-hypotheses.test.ts`
Expected: PASS (all tests pass).

**Step 5: Commit**

```bash
git add mcp-server/src/mcp/index.ts mcp-server/src/server.ts mcp-server/dashboard/js/04-playground-form.js mcp-server/dashboard/partials/09-quickstart.html mcp-server/scripts/verification/showfor-claims.ts mcp-server/docs/skill/references/reverse_tool.md mcp-server/tests/reverse-mcp-integration.test.ts
git commit -m "feat(reverse): expose reverse_tool via MCP server, REST API, and dashboard playground" -m "Problem: reverse_tool was not exposed via the primary MCP tools schema, the HTTP server endpoints, or the web dashboard playground." -m "Implementation & Verification: Added reverse_tool to MCP TOOLS array, added /api/reverse_tool endpoint, registered playground schema with showfor-claims, and created reference docs. Verified with reverse-mcp-integration.test.ts and dashboard-showfor-hypotheses.test.ts."
```

---

### Task 8: End-to-End Regression & Precommit Verification

**Files:**
- All touched files

**Step 1: Run complete test suite**

Run: `npm --prefix mcp-server test -- tests/reverse-*.test.ts`
Expected: PASS across all 8 test suites.

**Step 2: Run smoke challenge suite**

Run: `npx --prefix mcp-server tsx mcp-server/scripts/smoke/reverse_proxy_smoke.ts`
Expected: 16/16 passed.

**Step 3: Run full precommit verification**

Run: `npm run verify:precommit`
Expected: All git hooks, linters, TypeScript compile checks, and showfor hypotheses pass.
