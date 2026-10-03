/**
 * T3 — AppSec harness declaration ships with the external ctf-katana project.
 *
 * By design this is NOT a builtin mcp-server declaration: it lives in the
 * target workspace's uniform dir (`<ctf-katana>/.free-llm-mcp/harness/appsec.yaml`)
 * so the AppSec agent's policy, budget and workspace scope version with the
 * project it audits. The test asserts the contract the runner relies on:
 * uniform-dir resolution, schema validity, workspace scoping to the
 * ctf-katana project root, coding_agents as LLM reasoning executor, and an
 * approval-gated fix role (the T7 write guard's subject).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { existsSync } from 'fs';
import { loadHarnessDeclaration, resolveDeclarationPath } from '../src/harness/declaration.js';
import { assertWorkspaceRootAllowed } from '../src/harness/policy.js';

// Default matches this machine's layout (sibling of the Desktop workspace);
// CTF_KATANA_ROOT overrides for other checkouts. The ctf-katana checkout is
// not vendored in this repo, so the suite skips (never fails) without it.
const CTF_KATANA_ROOT = process.env.CTF_KATANA_ROOT
  ?? path.resolve(__dirname, '..', '..', '..', 'AVST', 'ctf-katana');

const APPSEC_DECL_PATH = path.join(CTF_KATANA_ROOT, '.free-llm-mcp', 'harness', 'appsec.yaml');

describe.skipIf(!existsSync(APPSEC_DECL_PATH))('appsec harness declaration (T3)', () => {
  it('ships at <ctf-katana>/.free-llm-mcp/harness/appsec.yaml and resolves via the uniform dir', async () => {
    const resolved = await resolveDeclarationPath('appsec', CTF_KATANA_ROOT);
    expect(resolved).toBe(path.join(CTF_KATANA_ROOT, '.free-llm-mcp', 'harness', 'appsec.yaml'));
    expect(existsSync(resolved)).toBe(true);
  });

  it('loads as a valid declaration: appsec lane, budget, handoff, contentDepth', async () => {
    const decl = await loadHarnessDeclaration('appsec', CTF_KATANA_ROOT);
    expect(decl.harness.name).toBe('appsec-harness');
    expect(decl.harness.schemaVersion).toBe(1);
    expect(decl.harness.primaryLane).toBe('appsec');
    expect(decl.harness.budget.maxTokens).toBeGreaterThan(0);
    expect(decl.harness.budget.maxToolCalls).toBeGreaterThan(0);
    expect(decl.harness.budget.maxWallMinutes).toBeGreaterThan(0);
    expect(decl.handoff.schemaVersion).toBe(1);
    expect(decl.contentDepth.order.length).toBeGreaterThan(0);
    expect(decl.writes.length).toBeGreaterThan(0);
  });

  it('scopes runs to the ctf-katana project root (relative root resolves against the declaration dir)', async () => {
    const decl = await loadHarnessDeclaration('appsec', CTF_KATANA_ROOT);
    expect(decl.harness.allowedWorkspaceRoots).toEqual([path.resolve(CTF_KATANA_ROOT)]);
    expect(() => assertWorkspaceRootAllowed(decl, CTF_KATANA_ROOT)).not.toThrow();
    expect(() => assertWorkspaceRootAllowed(decl, path.resolve(__dirname))).toThrow(/not permitted/);
  });

  it('routes LLM reasoning through coding_agents and gates the fix role behind approval', async () => {
    const decl = await loadHarnessDeclaration('appsec', CTF_KATANA_ROOT);
    expect(Object.keys(decl.roles)).toContain('top_level');

    const executors = Object.entries(decl.roles).filter(
      ([name, def]) => name !== 'top_level' && def.tools.some(t => t.tool === 'coding_agents'),
    );
    expect(executors.length).toBeGreaterThanOrEqual(1);
    const triggers = executors.flatMap(([, def]) => def.triggers ?? []);
    expect(triggers.length).toBeGreaterThan(0);

    const gatedRoles = Object.entries(decl.roles).filter(([, def]) => def.requiresApproval === true);
    expect(gatedRoles.length).toBeGreaterThanOrEqual(1);
    const gatedTools = gatedRoles.flatMap(([, def]) => def.tools.map(t => t.tool));
    expect(gatedTools).toContain('coding_agents');
  });
});
