import { describe, it, expect } from 'vitest';
import {
  classifyDocAudience,
  generateDocSchematic,
  MERMAID_DIAGRAM_TYPES,
} from '../src/memory/mermaid-classifier.js';

describe('Document Audience Classifier & Schematic Generator', () => {
  it('classifies public-facing docs accurately with appropriate diagrams', () => {
    const readmeRes = classifyDocAudience('README.md', '# Overview\nWelcome to the tool. User getting started guide.');
    expect(readmeRes.audience).toBe('public');
    expect(readmeRes.recommendedDiagrams).toContain('flowchart');
    expect(readmeRes.recommendedDiagrams).toContain('journey');

    const setupRes = classifyDocAudience('docs/setup.md', 'Installation steps and quickstart.');
    expect(setupRes.audience).toBe('public');

    const agenticPromptsRes = classifyDocAudience('mcp-server/docs/agentic-prompts.md', 'User prompts and system workflows.');
    expect(agenticPromptsRes.audience).toBe('public');
  });

  it('classifies dev-facing docs accurately with appropriate diagrams', () => {
    const devDocRes = classifyDocAudience('mcp-server/docs/mcp-development.md', 'IPC protocol handshakes, state machines, and contract models.');
    expect(devDocRes.audience).toBe('dev');
    expect(devDocRes.recommendedDiagrams).toContain('sequenceDiagram');
    expect(devDocRes.recommendedDiagrams).toContain('classDiagram');
    expect(devDocRes.recommendedDiagrams).toContain('stateDiagram-v2');

    const agentsMdRes = classifyDocAudience('AGENTS.md', 'Agent guidelines, symbol contracts, and AST linting.');
    expect(agentsMdRes.audience).toBe('dev');

    const adrRes = classifyDocAudience('docs/adr/001-memory.md', 'Architecture decision record for symbols.');
    expect(adrRes.audience).toBe('dev');
  });

  it('generates a concise doc schematic deterministically without LLM', () => {
    const devContent = `# Developer Guide
This document explains the internal IPC handshake and state lifecycle.
\`\`\`mermaid
sequenceDiagram
  Client->>Server: Handshake
\`\`\`
`;
    const schematic = generateDocSchematic('mcp-server/docs/internal.md', devContent);
    expect(schematic.filePath).toBe('mcp-server/docs/internal.md');
    expect(schematic.audience).toBe('dev');
    expect(schematic.existingDiagrams).toHaveLength(1);
    expect(schematic.existingDiagrams[0].keyword).toBe('sequenceDiagram');
    expect(schematic.summary).toBeDefined();
    expect(typeof schematic.summary).toBe('string');
  });

  it('suggests missing diagrams when an architectural doc lacks them', () => {
    const content = '# Architecture Overview\nExplains system containers, components, and pipelines.';
    const schematic = generateDocSchematic('docs/architecture.md', content);
    expect(schematic.missingDiagrams.length).toBeGreaterThan(0);
  });
});
