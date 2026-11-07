import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  discoverSkillsInTree,
  parseSkillMdContent,
  parseReadmeSkills,
  installRepoSkill,
  parseGitHubRepoUrl,
  loadSkillPromptFromRepo,
  discoverRepoSkills,
} from '../src/reverse/github-skills.js';
import { loadSkillPrompt, safeSkillSlug } from '../src/tools/load-skill-prompt.js';
import { mockFetch } from './helpers/mock-fetch.js';

describe('GitHub Skill Repository Discovery & Downloader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses GitHub repo URLs and owner/repo handles accurately', () => {
    expect(parseGitHubRepoUrl('https://github.com/JuliusBrussee/caveman')).toEqual({
      owner: 'JuliusBrussee',
      repo: 'caveman',
    });
    expect(parseGitHubRepoUrl('https://github.com/JuliusBrussee/caveman.git')).toEqual({
      owner: 'JuliusBrussee',
      repo: 'caveman',
    });
    expect(parseGitHubRepoUrl('JuliusBrussee/caveman')).toEqual({
      owner: 'JuliusBrussee',
      repo: 'caveman',
    });
    expect(parseGitHubRepoUrl('https://github.com/inceptionstack/loki-skills/')).toEqual({
      owner: 'inceptionstack',
      repo: 'loki-skills',
    });
    expect(parseGitHubRepoUrl('plain-string')).toBeNull();
    expect(parseGitHubRepoUrl('')).toBeNull();
  });

  it('parses SKILL.md frontmatter and description accurately', () => {
    const raw = `---
name: caveman
description: Ultra-compressed communication mode. Cuts output tokens 65% by speaking like caveman.
tools:
  - use_free_llm
---
# Caveman Mode
Cut noise, keep technical signal.`;

    const parsed = parseSkillMdContent('skills/caveman/SKILL.md', raw);
    expect(parsed.name).toBe('caveman');
    expect(parsed.description).toContain('Ultra-compressed communication mode');
    expect(parsed.path).toBe('skills/caveman/SKILL.md');
  });

  it('filters and identifies skill paths in skills/ folder, .claude/skills/ or root', () => {
    const tree = [
      { path: 'src/index.ts', type: 'blob' },
      { path: 'skills/caveman/SKILL.md', type: 'blob' },
      { path: 'skills/caveman-commit/SKILL.md', type: 'blob' },
      { path: '.claude/skills/audit/SKILL.md', type: 'blob' },
      { path: 'SKILL.md', type: 'blob' },
      { path: 'skills/helper/helper.ts', type: 'blob' },
    ];

    const paths = discoverSkillsInTree(tree);
    expect(paths).toHaveLength(4);
    expect(paths).toContain('skills/caveman/SKILL.md');
    expect(paths).toContain('skills/caveman-commit/SKILL.md');
    expect(paths).toContain('.claude/skills/audit/SKILL.md');
    expect(paths).toContain('SKILL.md');

    // Also works when type is undefined (e.g. RemoteFileDescriptor)
    const descriptorsWithoutType = [
      { path: 'skills/my-skill/SKILL.md' },
      { path: 'README.md' },
    ];
    const descPaths = discoverSkillsInTree(descriptorsWithoutType);
    expect(descPaths).toEqual(['skills/my-skill/SKILL.md']);
  });

  it('parses README-based skills from markdown tables, bullet lists, and headers (loki-skills format)', () => {
    const readmeSample = `# Loki Skills Library
Agent skills library for Loki — adapted from Kiro Powers and custom-built for AI agent workflows.

## Available Skills

| Skill | Description | Path |
| --- | --- | --- |
| security-scanner | Comprehensive security auditor and OWASP tester | skills/security-scanner |
| api-architect | Microservices and scalable REST API designer | skills/api-architect |

## Extra Powers
- **github-harness**: Autonomous harness for GitHub repository inspection
- [browser-automation](skills/browser-automation) - Headless browser automation subagent
* \`quantum-sim\`: Cirq and Qiskit quantum circuit development tool

### memory-leak-finder
Diagnoses and resolves heap memory leaks in Node.js applications.
`;

    const skills = parseReadmeSkills(readmeSample);
    const skillNames = skills.map(s => s.name);

    expect(skillNames).toContain('security-scanner');
    expect(skillNames).toContain('api-architect');
    expect(skillNames).toContain('github-harness');
    expect(skillNames).toContain('browser-automation');
    expect(skillNames).toContain('quantum-sim');
    expect(skillNames).toContain('memory-leak-finder');

    const secScanner = skills.find(s => s.name === 'security-scanner');
    expect(secScanner?.description).toContain('Comprehensive security auditor');
    expect(secScanner?.path).toBe('skills/security-scanner');

    const browserSkill = skills.find(s => s.name === 'browser-automation');
    expect(browserSkill?.description).toContain('Headless browser automation');
    expect(browserSkill?.path).toBe('skills/browser-automation');
  });

  it('downloads skill files from GitHub repo and overwrites existing files if already present', async () => {
    // 1. Pre-create an older existing skill
    const targetSkillsDir = path.join(tmpDir, 'skills');
    const existingSkillDir = path.join(targetSkillsDir, 'caveman');
    fs.mkdirSync(existingSkillDir, { recursive: true });
    fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), '# Old Caveman Skill', 'utf8');

    // 2. Mock raw GitHub fetch for updated skill files
    const { fetchImpl } = mockFetch([
      {
        match: 'raw.githubusercontent.com/JuliusBrussee/caveman/main/skills/caveman/SKILL.md',
        body: '---\nname: caveman\ndescription: Viral skill that cuts 65% tokens\n---\n# New Caveman Skill',
      },
    ]);

    const installRes = await installRepoSkill({
      owner: 'JuliusBrussee',
      repo: 'caveman',
      ref: 'main',
      skillSubpath: 'skills/caveman',
      targetDir: targetSkillsDir,
      overwrite: true,
      fetchImpl,
    });

    expect(installRes.success).toBe(true);
    expect(installRes.skillName).toBe('caveman');

    // 3. Verify the file was overwritten
    const updatedContent = fs.readFileSync(path.join(existingSkillDir, 'SKILL.md'), 'utf8');
    expect(updatedContent).toContain('# New Caveman Skill');
    expect(updatedContent).not.toContain('# Old Caveman Skill');
  });

  it('loadSkillPromptFromRepo handles a GitHub repo link directly, loading from skills/ and overwriting', async () => {
    const targetSkillsDir = path.join(tmpDir, 'skills');
    const existingSkillDir = path.join(targetSkillsDir, 'caveman');
    fs.mkdirSync(existingSkillDir, { recursive: true });
    fs.writeFileSync(path.join(existingSkillDir, 'SKILL.md'), '# Outdated Caveman', 'utf8');

    const treePayload = {
      sha: 'c1234567890',
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'skills/caveman/SKILL.md', type: 'blob' },
      ],
    };

    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/JuliusBrussee/caveman/git/trees/main', body: treePayload },
      {
        match: 'raw.githubusercontent.com/JuliusBrussee/caveman/c1234567890/skills/caveman/SKILL.md',
        body: '---\nname: caveman\ndescription: Viral skill that cuts 65% tokens\n---\n# Modern Caveman Skill',
      },
      {
        match: 'raw.githubusercontent.com/JuliusBrussee/caveman/c1234567890/README.md',
        body: '# Caveman\nCompress LLM communication tokens.',
      },
    ]);

    const res = await loadSkillPromptFromRepo({
      repoUrl: 'https://github.com/JuliusBrussee/caveman',
      workspaceDir: tmpDir,
      targetSkillsDir,
      overwrite: true,
      fetchImpl,
    });

    expect(res.success).toBe(true);
    expect(res.skill).toBe('caveman');
    expect(res.prompt).toContain('# Modern Caveman Skill');

    const overwritten = fs.readFileSync(path.join(existingSkillDir, 'SKILL.md'), 'utf8');
    expect(overwritten).toContain('# Modern Caveman Skill');
  });

  it('bridges loadSkillPrompt when input name/skill is a GitHub repo URL', async () => {
    const targetSkillsDir = path.join(tmpDir, 'skills');
    const treePayload = {
      sha: 'def987654321',
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'skills/loki/SKILL.md', type: 'blob' },
      ],
    };

    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/inceptionstack/loki-skills/git/trees/main', body: treePayload },
      {
        match: 'raw.githubusercontent.com/inceptionstack/loki-skills/def987654321/skills/loki/SKILL.md',
        body: '---\nname: loki\ndescription: Loki agent workflows\n---\n# Loki Master Skill',
      },
      {
        match: 'raw.githubusercontent.com/inceptionstack/loki-skills/def987654321/README.md',
        body: '# Loki Skills\nLoki AI workflows.',
      },
    ]);

    const res = await loadSkillPrompt({
      type: 'load',
      name: 'https://github.com/inceptionstack/loki-skills',
      workspaceDir: tmpDir,
      ...({ fetchImpl, targetSkillsDir } as any),
    });

    expect(res.success).toBe(true);
    expect(res.skill).toBe('loki');
    expect(res.prompt).toContain('# Loki Master Skill');
  });

  it('safeSkillSlug rejects path traversal on malicious frontmatter name (../../root)', async () => {
    expect(safeSkillSlug('../../root')).toBeNull();

    const targetSkillsDir = path.join(tmpDir, 'skills');
    const { fetchImpl } = mockFetch([
      {
        match: 'raw.githubusercontent.com/evil/repo/main/skills/malicious/SKILL.md',
        body: '---\nname: ../../root\ndescription: malicious traversal\n---\n# Exploit',
      },
    ]);

    const res = await installRepoSkill({
      owner: 'evil',
      repo: 'repo',
      ref: 'main',
      skillSubpath: 'skills/malicious',
      targetDir: targetSkillsDir,
      fetchImpl,
    });

    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
    expect(fs.existsSync(path.join(tmpDir, 'root'))).toBe(false);
  });

  it('loadSkillPrompt with type: list or search returns skills without writing to disk', async () => {
    const targetSkillsDir = path.join(tmpDir, 'skills');
    const treePayload = {
      sha: 'abc123456',
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'skills/security-scanner/SKILL.md', type: 'blob' },
        { path: 'skills/api-architect/SKILL.md', type: 'blob' },
      ],
    };

    const readmeContent = `# Skills\n- **security-scanner**: OWASP security auditor\n- **api-architect**: REST API design`;

    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/testowner/testrepo/git/trees/main', body: treePayload },
      { match: 'raw.githubusercontent.com/testowner/testrepo/abc123456/README.md', body: readmeContent },
    ]);

    // Test list
    const listRes = await loadSkillPrompt({
      type: 'list',
      name: 'https://github.com/testowner/testrepo',
      workspaceDir: tmpDir,
      ...({ fetchImpl, targetSkillsDir } as any),
    });

    expect(listRes.success).toBe(true);
    expect(listRes.skills).toBeDefined();
    expect(listRes.skills!.map(s => s.name).sort()).toEqual(['api-architect', 'security-scanner']);
    expect(fs.existsSync(targetSkillsDir)).toBe(false);

    // Test search
    const searchRes = await loadSkillPrompt({
      type: 'search',
      name: 'https://github.com/testowner/testrepo',
      keywords: ['security'],
      workspaceDir: tmpDir,
      ...({ fetchImpl, targetSkillsDir } as any),
    });

    expect(searchRes.success).toBe(true);
    expect(searchRes.skills).toHaveLength(1);
    expect(searchRes.skills![0].name).toBe('security-scanner');
    expect(fs.existsSync(targetSkillsDir)).toBe(false);
  });

  it('loadSkillPromptFromRepo with unknown skillName returns honest error with available skills list', async () => {
    const targetSkillsDir = path.join(tmpDir, 'skills');
    const treePayload = {
      sha: 'xyz987',
      truncated: false,
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'skills/scanner/SKILL.md', type: 'blob' },
        { path: 'skills/fuzzer/SKILL.md', type: 'blob' },
      ],
    };

    const readmeContent = `# Skills\n| Skill | Description |\n| --- | --- |\n| scanner | Security scan |\n| fuzzer | Web fuzzer |`;

    const { fetchImpl } = mockFetch([
      { match: 'api.github.com/repos/testowner/testrepo/git/trees/main', body: treePayload },
      { match: 'raw.githubusercontent.com/testowner/testrepo/xyz987/README.md', body: readmeContent },
    ]);

    const res = await loadSkillPromptFromRepo({
      repoUrl: 'https://github.com/testowner/testrepo',
      skillName: 'nonexistent-skill',
      workspaceDir: tmpDir,
      targetSkillsDir,
      fetchImpl,
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe(
      'Skill "nonexistent-skill" was not found in repository "testowner/testrepo". Available skills: scanner, fuzzer'
    );
  });
});
