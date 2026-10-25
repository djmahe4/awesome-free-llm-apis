import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { safeSkillSlug, resolveSkillFile } from '../src/tools/load-skill-prompt.js';

// The skill index and file listing come from a remote repository. Their ids and paths are joined into local
// paths and written to disk, so a hostile (or merely broken) entry must not be able to write outside the
// skills folder.

describe('safeSkillSlug', () => {
  it.each(['my-skill', 'a.b_c', 'Skill123', 'x'])('accepts %s', id => { expect(safeSkillSlug(id)).toBe(id); });
  it.each(['../evil', '..', '.', 'a/b', 'a\\b', '', ' ', '-leading-dash', '.hidden', 'x'.repeat(200), 'nul\u0000byte', 'C:evil', '/abs'])('rejects %j', id => {
    expect(safeSkillSlug(id)).toBeNull();
  });
  it('rejects non-strings', () => {
    expect(safeSkillSlug(undefined as any)).toBeNull();
    expect(safeSkillSlug(42 as any)).toBeNull();
  });
});

describe('resolveSkillFile', () => {
  const dir = path.join(os.tmpdir(), 'skills-root', 'demo');
  it('resolves ordinary relative files inside the skill folder', () => {
    expect(resolveSkillFile(dir, 'SKILL.md')).toBe(path.join(dir, 'SKILL.md'));
    expect(resolveSkillFile(dir, 'references/deep/a.md')).toBe(path.join(dir, 'references', 'deep', 'a.md'));
  });
  it.each(['../x', '../../x', 'references/../../x', '/etc/passwd', 'C:\\Windows\\x', '', 'a\u0000b'])('refuses %j', rel => {
    expect(resolveSkillFile(dir, rel)).toBeNull();
  });
});
