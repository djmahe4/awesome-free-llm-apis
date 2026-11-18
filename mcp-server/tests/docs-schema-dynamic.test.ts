import { describe, it, expect } from 'vitest';
import { DocsSchemaManager } from '../src/memory/docs-schema-manager.js';
import path from 'node:path';

describe('DocsSchemaManager dynamic scan', () => {
  it('discovers code and docs without any hardcoded paths', async () => {
    const root = path.resolve(__dirname, '..', '..');
    const mgr = DocsSchemaManager.getInstance();
    const schema = await mgr.generateSuggestedSchema(root, false);

    expect(schema.codeDocsMapping.length).toBeGreaterThan(5);
    const mcpToolsMapped = schema.codeDocsMapping.filter(m => m.docPath.includes('references'));
    expect(mcpToolsMapped.length).toBeGreaterThan(3);

    // Verify diagramExpected is always a valid orientation and never bare flowchart
    for (const m of schema.codeDocsMapping) {
      if (m.diagramExpected) {
        expect(m.diagramExpected).not.toBe('flowchart');
        expect(m.diagramExpected.includes(';') || m.diagramExpected.endsWith(';')).toBe(false);
      }
    }
  });
});
