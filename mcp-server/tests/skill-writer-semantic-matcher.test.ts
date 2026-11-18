import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  matchSkillWriterRules,
  formatCompactDriftPill,
  MemoryAuditor,
} from '../src/memory/memory-auditor.js';

describe('Deterministic skill-writer Semantic Matcher & Compact Drift Pill', () => {
  it('detects compliant skill-writer structure deterministically', () => {
    const validSkill = `---
name: my-agent-skill
description: Comprehensive testing and linting agent skill for vitest and eslint workflows.
---
# My Agent Skill
## When to Use
Use when testing or linting code.
## Limitations
Does not fix hardware issues.
## Output format
1. Summary
2. Changes Made
3. Validation Results
4. Open Gaps
`;
    const res = matchSkillWriterRules(validSkill, ['vitest', 'eslint']);
    expect(res.compliant).toBe(true);
    expect(res.missingSections).toHaveLength(0);
    expect(res.driftSuggestions).toHaveLength(0);
  });

  it('detects structural violations and missing triggers deterministically without LLM', () => {
    const shallowSkill = `
# Incomplete Skill
Just some random text without frontmatter or contracts.
`;
    const res = matchSkillWriterRules(shallowSkill, ['vitest', 'deploy_tool']);
    expect(res.compliant).toBe(false);
    expect(res.missingSections).toContain('frontmatter');
    expect(res.missingSections).toContain('Output format contract');
    expect(res.missingSections).toContain('## When to Use');
  });

  it('formats compact drift pills strictly under 300 characters', () => {
    const pill = formatCompactDriftPill({
      docsCount: 2,
      skillsCount: 1,
      docSamples: ['README.md', 'mcp-development.md'],
      skillSamples: ['skill-writer'],
    });

    expect(pill.length).toBeLessThan(300);
    expect(pill).toContain('Memory Drift Alert');
    expect(pill).toContain('manage_memory');
  });

  it('remediates skill drift with local model advisory when local model is offline', async () => {
    const auditor = new MemoryAuditor();
    const result = await auditor.applySkillDriftRemediation({
      skillContent: '# Raw Skill',
      driftReason: 'Missing frontmatter and triggers',
      allowCloudFallback: false,
      forceDeterministic: true,
    });

    expect(result.success).toBe(true);
    expect(result.remediationType).toBe('deterministic_template');
    if (!result.localModelUsed) {
      expect(result.reminder).toContain('allowCloudFallback: true');
    }
  });
});
