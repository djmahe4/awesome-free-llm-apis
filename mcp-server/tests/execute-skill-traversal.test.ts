import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { extractReferencedFiles, resolveReferences, readReferenceFile } from '../src/tools/execute-skill.js';

// SKILL.md text can come from a downloaded (untrusted) skill. Its `references/...` mentions are read from
// disk and injected into an LLM prompt, so a reference that climbs out of the skill folder would send
// arbitrary local files (an SSH key, an .env) to a cloud model.

describe('skill reference containment', () => {
  let root = '';
  let skillDir = '';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-trav-'));
    skillDir = path.join(root, 'skills', 'demo');
    await fs.ensureDir(path.join(skillDir, 'references'));
    await fs.writeFile(path.join(skillDir, 'references', 'ok.md'), 'allowed content');
    await fs.writeFile(path.join(root, 'secret.txt'), 'TOP SECRET');
    await fs.ensureDir(path.join(root, 'skills', 'other'));
    await fs.writeFile(path.join(root, 'skills', 'other', 'notes.md'), 'another skill');
  });
  afterEach(async () => { await fs.remove(root); });

  it('extracts references from SKILL.md text exactly as before', () => {
    const refs = extractReferencedFiles('See `references/ok.md` and [guide](resources/guide.md) and `examples/a.txt`.');
    expect(refs.sort()).toEqual(['examples/a.txt', 'references/ok.md', 'resources/guide.md']);
  });

  it('a normal reference resolves', async () => {
    const r = await resolveReferences(skillDir, ['references/ok.md']);
    expect(r.availableRefs).toEqual(['references/ok.md']);
    expect(r.blockedRefs).toEqual([]);
  });

  it.each([
    'references/../../../secret.txt',
    'references/../../other/notes.md',
    'references/..\\..\\..\\secret.txt',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'references/\u0000/x',
  ])('refuses %j and never lists it as available', async (ref) => {
    const r = await resolveReferences(skillDir, [ref]);
    expect(r.availableRefs).toEqual([]);
    expect(r.blockedRefs.length + r.missingRefs.length).toBe(1);
  });

  it('refuses a wildcard that climbs out of the skill folder', async () => {
    const r = await resolveReferences(skillDir, ['references/../../other/*.md', 'references/../../*.txt']);
    expect(r.availableRefs).toEqual([]);
  });

  it('a wildcard inside the skill folder still works', async () => {
    await fs.writeFile(path.join(skillDir, 'references', 'b.md'), 'b');
    const r = await resolveReferences(skillDir, ['references/*.md']);
    expect(r.availableRefs.sort()).toEqual(['references/b.md', 'references/ok.md']);
  });

  it('a symlink inside the skill folder that points outside is not followed', async () => {
    try {
      await fs.symlink(path.join(root, 'secret.txt'), path.join(skillDir, 'references', 'link.md'));
    } catch {
      return; // symlinks need privileges on some Windows setups: nothing to test there
    }
    const r = await resolveReferences(skillDir, ['references/link.md']);
    expect(r.availableRefs).toEqual([]);
    expect(await readReferenceFile(skillDir, 'references/link.md')).toBeNull();
  });

  it('readReferenceFile re-checks containment (defence in depth) and reads allowed files', async () => {
    expect(await readReferenceFile(skillDir, 'references/ok.md')).toBe('allowed content');
    expect(await readReferenceFile(skillDir, 'references/../../../secret.txt')).toBeNull();
    expect(await readReferenceFile(skillDir, '../secret.txt')).toBeNull();
  });
});
