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
      expect(result.reminder).toContain('hypothesize: true');
    }
  });

  it('detects excessive line length, token footprint, and reference dump anti-patterns', () => {
    const lines = [
      '---',
      'name: bloated-skill',
      'description: Demonstrates bloated skill anti-pattern',
      '---',
      '# Bloated Skill',
      '## When to Use\nUse for testing.',
      '## Limitations\nNone.',
      '## Output format\n1. Output',
      ...Array(300).fill('Some verbose explanation line that takes up unnecessary space in context.'),
      '## Deep Dives & References',
      '- [Tool A](references/tool_a.md)',
      '- [Tool B](references/tool_b.md)',
    ];
    const bloatedSkill = lines.join('\n');

    const res = matchSkillWriterRules(bloatedSkill, [], { maxLines: 250 });
    expect(res.compliant).toBe(false);
    expect(res.excessiveLength).toBe(true);
    expect(res.unstructuredReferenceDump).toBe(true);
    expect(res.lineCount).toBeGreaterThan(300);
    expect(res.tokenOptimization?.estimatedTokens).toBeGreaterThan(2000);
    expect(res.tokenOptimization?.potentialSavingsTokens).toBeGreaterThan(500);
    expect(res.driftSuggestions.some(s => s.includes('exceeds recommended budget'))).toBe(true);
    expect(res.driftSuggestions.some(s => s.includes('Unstructured reference list'))).toBe(true);
  });

  it('identifies inline tool documentation duplication and provides token savings suggestions', () => {
    const skillWithDuplication = `---
name: duplicate-docs-skill
description: Duplicates reference documentation inline
---
# Duplicate Docs Skill
## When to Use
Use when testing.
## Limitations
None.
## Output format
1. Output

### cyber_tool
${Array(20).fill('Parameter detail line explaining security actions in depth.').join('\n')}

See [cyber_tool](references/cyber_tool.md).
`;

    const res = matchSkillWriterRules(skillWithDuplication, ['cyber_tool']);
    expect(res.tokenOptimization?.suggestions.some(s => s.includes('cyber_tool'))).toBe(true);
    expect(res.referencedFiles).toContain('cyber_tool.md');
  });
});
