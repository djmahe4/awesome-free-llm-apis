/**
 * T8 (red first) — cyber_tool `run_action`: a GENERAL project-bridge
 * mechanism, not cyber-specific — it must work for multiple servers /
 * project folders.
 *
 * `<workspaceRoot>/.free-llm-mcp/bridges.json` declares named bridges
 * (command argv + optional cwd). run_action checks the caller's
 * authorization framing (ctf/lab/consent), resolves the bridge (explicit
 * name, or auto-select when exactly one is declared), spawns it as a
 * subprocess with `{actionName, target, args, authorization}` on stdin and
 * parses ONE JSON object from stdout (the bridge's Finding). Every failure
 * mode returns `{success:false, error}` instead of throwing.
 *
 * Trust model: bridges.json is a capability token — whoever can write the
 * project's config decides what the harness may spawn; cwd must still stay
 * inside workspaceRoot.
 *
 * Harness side: top-level `cyberTools` on the declaration fail-closes
 * evaluate() — a role may allowlist cyber_tool/run_action, but the bridge
 * must also appear in `decl.cyberTools` (absent list = no bridge ever
 * dispatches through the harness). ctf-katana's appsec.yaml ships
 * `cyberTools: [katana]`; the bridge adapter itself lives in ctf-katana
 * (cli/cyber_bridge.py → server/utils/dispatch.py).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

import { cyberTool } from '../src/tools/cyber-tool.js';
import { evaluate } from '../src/harness/policy.js';
import { loadHarnessDeclaration } from '../src/harness/declaration.js';
import type { HarnessDeclaration } from '../src/harness/types.js';

// Default matches this machine's layout; CTF_KATANA_ROOT overrides elsewhere/CI.
const CTF_KATANA_ROOT = process.env.CTF_KATANA_ROOT
  ?? path.resolve(__dirname, '..', '..', '..', 'AVST', 'ctf-katana');

const FAKE_BRIDGE = `#!/usr/bin/env node
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const req = JSON.parse(raw || '{}');
process.stdout.write(JSON.stringify({ tool: 'fake', target: req.target, status: 'ok', salient: 'fake bridge ran', received: req, bridgeEnv: { MARK: process.env.BRIDGE_MARK ?? null, LEAK: process.env.BRIDGE_SECRET_MARKER ?? null } }));
`;

const BROKEN_BRIDGE = `#!/usr/bin/env node
process.stdout.write('this is not json');
process.exit(1);
`;

let ws: string;

async function writeConfig(cfg: unknown): Promise<void> {
  const dir = path.join(ws, '.free-llm-mcp');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'bridges.json'), JSON.stringify(cfg), 'utf-8');
}

function singleFakeConfig() {
  return { bridges: { fake: { command: ['node', 'fake-bridge.mjs'], cwd: '.' } } };
}

function multiConfig() {
  return {
    bridges: {
      fake: { command: ['node', 'fake-bridge.mjs'], cwd: '.' },
      broken: { command: ['node', 'broken-bridge.mjs'], cwd: '.' },
    },
  };
}

describe('T8 cyber_tool run_action — project bridge dispatch', () => {
  beforeAll(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 't8-bridge-'));
    process.env.BRIDGE_WORKSPACE_ROOTS = ws;
    await fs.writeFile(path.join(ws, 'fake-bridge.mjs'), FAKE_BRIDGE, 'utf-8');
    await fs.writeFile(path.join(ws, 'broken-bridge.mjs'), BROKEN_BRIDGE, 'utf-8');
  });

  afterAll(async () => {
    delete process.env.BRIDGE_WORKSPACE_ROOTS;
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await fs.rm(path.join(ws, '.free-llm-mcp'), { recursive: true, force: true }).catch(() => {});
  });

  it('spawns the single declared bridge (auto-select) and returns its parsed JSON finding', async () => {
    await writeConfig(singleFakeConfig());
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'ctf',
      actionName: 'strings',
      target: 'challenge.bin',
      args: { min_len: 8 },
    } as any);
    expect(result.success).toBe(true);
    expect(result.bridge).toBe('fake');
    expect(result.finding).toMatchObject({ tool: 'fake', status: 'ok' });
    // what the bridge actually received over stdin (payload passthrough)
    expect(result.finding.received).toMatchObject({
      actionName: 'strings',
      target: 'challenge.bin',
      args: { min_len: 8 },
      authorization: 'ctf',
    });
  });

  it('selects the named bridge when several are declared', async () => {
    await writeConfig(multiConfig());
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'lab',
      bridge: 'fake',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(true);
    expect(result.bridge).toBe('fake');
  });

  it('refuses to guess when several bridges are declared and none is named', async () => {
    await writeConfig(multiConfig());
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'ctf',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/bridge/i);
  });

  it('errors on an unknown bridge name', async () => {
    await writeConfig(multiConfig());
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'ctf',
      bridge: 'nonexistent',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/nonexistent|unknown|bridge/i);
  });

  it('errors when the project declares no bridges.json', async () => {
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'ctf',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/bridges\.json/);
  });

  it('requires explicit CTF/lab/consent authorization framing', async () => {
    await writeConfig(singleFakeConfig());
    const missing = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(missing.success).toBe(false);
    expect(String(missing.error)).toMatch(/authorization/i);

    const invalid = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'random-internet-target',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(invalid.success).toBe(false);
    expect(String(invalid.error)).toMatch(/authorization/i);
  });

  it('rejects a bridge cwd that escapes the workspace root', async () => {
    await writeConfig({ bridges: { escape: { command: ['node', 'fake-bridge.mjs'], cwd: '../../..' } } });
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'ctf',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/cwd|escape|outside/i);
  });

  it('does not pass the server environment to the bridge (opt-in env only)', async () => {
    process.env.BRIDGE_SECRET_MARKER = 'server-secret';
    await writeConfig({
      bridges: { fake: { command: ['node', 'fake-bridge.mjs'], cwd: '.', env: { BRIDGE_MARK: 'ok' } } },
    });
    try {
      const result = await cyberTool({
        action: 'run_action',
        workspaceRoot: ws,
        authorization: 'ctf',
        actionName: 'strings',
        target: 'x.bin',
      } as any);
      expect(result.success).toBe(true);
      const env = (result.finding as any).bridgeEnv;
      expect(env.MARK).toBe('ok');
      expect(env.LEAK).toBeNull();
    } finally {
      delete process.env.BRIDGE_SECRET_MARKER;
    }
  });

  it('rejects a bridge env declaration that is not a string map', async () => {
    await writeConfig({ bridges: { fake: { command: ['node', 'fake-bridge.mjs'], cwd: '.', env: 'oops' } } });
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'ctf',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/env/i);
  });

  it('rejects a workspaceRoot outside BRIDGE_WORKSPACE_ROOTS', async () => {
    await writeConfig(singleFakeConfig());
    const prev = process.env.BRIDGE_WORKSPACE_ROOTS;
    process.env.BRIDGE_WORKSPACE_ROOTS = path.join(ws, 'not-this-one');
    try {
      const result = await cyberTool({
        action: 'run_action',
        workspaceRoot: ws,
        authorization: 'ctf',
        actionName: 'strings',
        target: 'x.bin',
      } as any);
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/BRIDGE_WORKSPACE_ROOTS|not permitted/i);
    } finally {
      process.env.BRIDGE_WORKSPACE_ROOTS = prev;
    }
  });

  it('allows a nested workspaceRoot inside an allowed root in BRIDGE_WORKSPACE_ROOTS (insideRoot / real() containment)', async () => {
    const nestedSubdir = path.join(ws, 'nested', 'project');
    const nestedConfigDir = path.join(nestedSubdir, '.free-llm-mcp');
    await fs.mkdir(nestedConfigDir, { recursive: true });
    await fs.writeFile(path.join(nestedSubdir, 'fake-bridge.mjs'), FAKE_BRIDGE, 'utf-8');
    await fs.writeFile(
      path.join(nestedConfigDir, 'bridges.json'),
      JSON.stringify(singleFakeConfig()),
      'utf-8'
    );

    const prev = process.env.BRIDGE_WORKSPACE_ROOTS;
    process.env.BRIDGE_WORKSPACE_ROOTS = ws; // ws is parent root
    try {
      const result = await cyberTool({
        action: 'run_action',
        workspaceRoot: nestedSubdir,
        authorization: 'ctf',
        actionName: 'test',
        target: 'x.bin',
      } as any);
      expect(result.success).toBe(true);
      expect((result as any).finding).toMatchObject({ tool: 'fake' });
    } finally {
      process.env.BRIDGE_WORKSPACE_ROOTS = prev;
    }
  });

  it('fails closed when BRIDGE_WORKSPACE_ROOTS is unset (bridge execution disabled)', async () => {
    await writeConfig(singleFakeConfig());
    const prev = process.env.BRIDGE_WORKSPACE_ROOTS;
    delete process.env.BRIDGE_WORKSPACE_ROOTS;
    try {
      const result = await cyberTool({
        action: 'run_action',
        workspaceRoot: ws,
        authorization: 'ctf',
        actionName: 'strings',
        target: 'x.bin',
      } as any);
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/BRIDGE_WORKSPACE_ROOTS is unset|bridge execution is disabled/i);
    } finally {
      process.env.BRIDGE_WORKSPACE_ROOTS = prev;
    }
  });

  it('surfaces bridge subprocess failures as success:false (never throws)', async () => {
    await writeConfig(multiConfig());
    const result = await cyberTool({
      action: 'run_action',
      workspaceRoot: ws,
      authorization: 'consent',
      bridge: 'broken',
      actionName: 'strings',
      target: 'x.bin',
    } as any);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('T8 harness gating — declaration cyberTools list', () => {
  const baseDecl = (extra: Partial<HarnessDeclaration> = {}): HarnessDeclaration => ({
    harness: {
      name: 'bridge-test',
      schemaVersion: 1,
      primaryLane: 'appsec',
      budget: { maxTokens: 1000, maxToolCalls: 10, maxWallMinutes: 5, supervisorShareMax: 0.2 },
      approval: { timeoutMinutes: 5, standingRules: [] },
    },
    roles: {
      analyst: { tools: [{ tool: 'cyber_tool', actions: ['run_action'] }] },
      limited: { tools: [{ tool: 'cyber_tool', actions: ['list_tools'] }] },
    },
    writes: [],
    contentDepth: { order: [], default: 'prompt' },
    handoff: { schemaVersion: 1, lowConfidenceThreshold: 0.5, maxDepth: 3 },
    ...extra,
  });

  it('allows a declared bridge that is listed in cyberTools', () => {
    const decl = baseDecl({ cyberTools: ['katana'] });
    expect(evaluate(decl, 'analyst', 'cyber_tool', 'run_action', { bridge: 'katana' }).kind).toBe('allow');
  });

  it('auto-resolves the single listed bridge when none is named', () => {
    const decl = baseDecl({ cyberTools: ['katana'] });
    expect(evaluate(decl, 'analyst', 'cyber_tool', 'run_action', {}).kind).toBe('allow');
  });

  it('needs approval for a bridge outside the cyberTools list', () => {
    const decl = baseDecl({ cyberTools: ['katana'] });
    const d = evaluate(decl, 'analyst', 'cyber_tool', 'run_action', { bridge: 'evil' });
    expect(d.kind).toBe('needs_approval');
  });

  it('fails closed when the declaration has no cyberTools list', () => {
    const decl = baseDecl();
    expect(evaluate(decl, 'analyst', 'cyber_tool', 'run_action', { bridge: 'katana' }).kind).toBe('needs_approval');
  });

  it('still requires the role to allowlist run_action', () => {
    const decl = baseDecl({ cyberTools: ['katana'] });
    expect(evaluate(decl, 'limited', 'cyber_tool', 'run_action', { bridge: 'katana' }).kind).toBe('needs_approval');
  });
});

// The ctf-katana checkout is not vendored in this repo — skip (never fail)
// this single contract test when it is absent.
const APPSEC_DECL_PATH = path.join(CTF_KATANA_ROOT, '.free-llm-mcp', 'harness', 'appsec.yaml');

describe.skipIf(!existsSync(APPSEC_DECL_PATH))('T8 appsec.yaml ships the cyberTools declaration', () => {
  it('lists the katana bridge for the ctf-katana harness', async () => {
    const decl = await loadHarnessDeclaration('appsec', CTF_KATANA_ROOT);
    expect(decl.cyberTools).toContain('katana');
  });
});
