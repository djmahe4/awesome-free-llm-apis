import { describe, it, expect } from 'vitest';
import { extractMdContext } from '../src/utils/md-extract.js';

describe('extractMdContext', () => {
    it('should extract headings and preserve structure', async () => {
        const input = `
# Project Alpha
## Installation
Run npm install.
### Usage
This is a long description of usage that should be filtered out to save tokens.
        `.trim();
        
        const result = await extractMdContext(input);
        expect(result).toContain('# Project Alpha');
        expect(result).toContain('## Installation');
        expect(result).toContain('### Usage');
        expect(result).not.toContain('Run npm install');
        expect(result).not.toContain('long description');
    });

    it('should extract declarative list items (assignments/definitions)', async () => {
        const input = `
- version: 1.0.6
- status = stable
- basic list item
- author: Antigravity
        `.trim();
        
        const result = await extractMdContext(input);
        expect(result).toContain('- version: 1.0.6');
        expect(result).toContain('- status = stable');
        expect(result).toContain('- author: Antigravity');
        expect(result).not.toContain('basic list item');
    });

    it('should extract code block headers and first 2 lines', async () => {
        const input = `
\`\`\`typescript {1,3}
import { x } from 'y';
const a = 1;
const b = 2;
const c = 3;
\`\`\`
        `.trim();
        
        const result = await extractMdContext(input);
        expect(result).toContain('```typescript {1,3}');
        expect(result).toContain("import { x } from 'y';");
        expect(result).toContain('const a = 1;');
        expect(result).not.toContain('const b = 2;');
        expect(result).not.toContain('const c = 3;');
    });

    it('should extract HTML comments as metadata tags', async () => {
        const input = `
<!-- TODO: Add authentication -->
# Title
<!-- NOTE: Re-indexing required -->
        `.trim();
        
        const result = await extractMdContext(input);
        expect(result).toContain('[META: TODO: Add authentication]');
        expect(result).toContain('[META: NOTE: Re-indexing required]');
    });

    it('should strictly respect character budget', async () => {
        const input = '# Heading One\n## Heading Two\n### Heading Three';
        const result = await extractMdContext(input, 15);
        expect(result.length).toBeLessThanOrEqual(15);
        expect(result).toContain('# Heading One');
        expect(result).not.toContain('Heading Three');
    });

    it('should fallback to raw text for empty signal files', async () => {
        const input = 'This is just some plain text without any structure.';
        const result = await extractMdContext(input);
        expect(result).toContain('This is just some plain text');
    });
});
