import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// AGENTS.md-based per-role skill access control (docs/harness-cyber.md
// pending task: "reuse existing AllowRule.constraints ... right mechanism,
// don't invent parallel one"). Verifies loadHarnessDeclaration merges a
// `## Skill Access` block from AGENTS.md into the matching role's tools as
// an execute_skill constraint rule, reusing the array-membership
// constraintsMatch fix already shipped in policy.ts.

describe('AGENTS.md skill-access merge into harness declaration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-skillaccess-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('injects an execute_skill/skillTags constraint rule for a role AGENTS.md declares', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      [
        '# Agent Configuration',
        '',
        '## Skill Access',
        '```yaml',
        'roles:',
        '  researcher: { skillTags: [research, osint] }',
        '```',
      ].join('\n')
    );

    const { loadHarnessDeclaration } = await import('../src/harness/declaration.js');
    const decl = await loadHarnessDeclaration('research-analysis', tmpDir);

    const rule = decl.roles.researcher.tools.find(
      t => t.tool === 'execute_skill' && Array.isArray((t.constraints as any)?.skillTags)
    );
    expect(rule).toBeDefined();
    expect((rule!.constraints as any).skillTags).toEqual(['research', 'osint']);
  });

  it('parses a skills: catalog from the Skill Access block into decl.skillCatalog with tags and dir', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      [
        '# Agent Configuration',
        '',
        '## Skill Access',
        '```yaml',
        'roles:',
        '  researcher: { skillTags: [research, osint] }',
        'skills:',
        '  bug_hunting:',
        '    tags: [bug-bounty, ctf, recon]',
        '    dir: skills/bug_hunting',
        '```',
      ].join('\n')
    );

    const { loadHarnessDeclaration } = await import('../src/harness/declaration.js');
    const decl = await loadHarnessDeclaration('research-analysis', tmpDir);

    expect((decl as any).skillCatalog?.bug_hunting).toEqual({
      tags: ['bug-bounty', 'ctf', 'recon'],
      dir: 'skills/bug_hunting',
    });

    const rule = decl.roles.researcher.tools.find(
      t => t.tool === 'execute_skill' && Array.isArray((t.constraints as any)?.skillTags)
    );
    expect(rule).toBeDefined();
  });

  it('ignores a role AGENTS.md mentions that does not exist in the harness declaration', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'AGENTS.md'),
      [
        '## Skill Access',
        '```yaml',
        'roles:',
        '  some_role_not_in_this_harness: { skillTags: [x] }',
        '```',
      ].join('\n')
    );

    const { loadHarnessDeclaration } = await import('../src/harness/declaration.js');
    const decl = await loadHarnessDeclaration('research-analysis', tmpDir);

    // No role in the real declaration should have picked up an 'x' tag rule.
    for (const role of Object.values(decl.roles)) {
      const rule = role.tools.find(t => t.tool === 'execute_skill' && (t.constraints as any)?.skillTags?.includes('x'));
      expect(rule).toBeUndefined();
    }
  });

  it('is a no-op when AGENTS.md has no Skill Access block (unchanged default behavior)', async () => {
    await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), '# Agent Configuration\n\nNo skill access section here.\n');

    const { loadHarnessDeclaration } = await import('../src/harness/declaration.js');
    const decl = await loadHarnessDeclaration('research-analysis', tmpDir);

    for (const role of Object.values(decl.roles)) {
      expect(role.tools.some(t => t.tool === 'execute_skill' && (t.constraints as any)?.skillTags)).toBe(false);
    }
  });

  it('is a no-op when no workspaceRoot is given at all', async () => {
    const { loadHarnessDeclaration } = await import('../src/harness/declaration.js');
    const decl = await loadHarnessDeclaration('research-analysis');
    for (const role of Object.values(decl.roles)) {
      expect(role.tools.some(t => t.tool === 'execute_skill' && (t.constraints as any)?.skillTags)).toBe(false);
    }
  });
});
