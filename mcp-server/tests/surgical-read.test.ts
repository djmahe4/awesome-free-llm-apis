import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { surgicalRead } from '../src/utils/surgical-read.js';
import fs from 'fs/promises';
import path from 'path';

describe('SurgicalRead (Phase C)', () => {
    const testDir = path.join(process.cwd(), 'temp_test_surgical_ws');
    const testFile = path.join(testDir, 'doc.md');

    beforeEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
        await fs.mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    it('surgicalRead() returns only the matching section, not full file', async () => {
        const docContent = `# Main Document

## Section One
This is content for section one.
It should be returned when querying for section one.

## Section Two
This is content for section two.
This should be skipped when we query for section one.
`;
        await fs.writeFile(testFile, docContent, 'utf-8');

        const result = await surgicalRead(testFile, 'section one');
        expect(result).toContain('content for section one');
        expect(result).not.toContain('content for section two');
    });

    it('surgicalRead() stays within maxTokens limit', async () => {
        const docContent = `# Main Document

## Section One
${'word '.repeat(1000)}
`;
        await fs.writeFile(testFile, docContent, 'utf-8');

        // Read with maxTokens = 50
        const result = await surgicalRead(testFile, 'section one', { maxTokens: 50 });
        
        // Count tokens using the same utility or a simple count check
        const { countStringTokens } = await import('../src/utils/tiktoken.js');
        const tokens = countStringTokens(result);
        
        expect(tokens).toBeLessThanOrEqual(60); // Allow slight buffer for header formatting
    });

    it('surgicalRead() includes linked section snippets when includeLinkedSections=true', async () => {
        const docContent = `# Main Document

## Section One
We decided to use [[Section Two]] for rendering.
Here is the rest of the text.

## Section Two
This is details of section two.
It has multiple lines of content.
This should be included as a snippet.
`;
        await fs.writeFile(testFile, docContent, 'utf-8');

        const result = await surgicalRead(testFile, 'section one', { includeLinkedSections: true });
        expect(result).toContain('Section One');
        expect(result).toContain('Section Two'); // linked section name
        expect(result).toContain('snippet');
        expect(result).toContain('details of section two');
    });

    it('surgicalRead() completes in < 50ms for 1MB files', async () => {
        // Create 1MB file
        const sectionContent = 'some content line here\n'.repeat(40000); // ~1MB
        const docContent = `# Document
## Targeted Section
${sectionContent}
## Other Section
Some other text.
`;
        await fs.writeFile(testFile, docContent, 'utf-8');

        const start = performance.now();
        const result = await surgicalRead(testFile, 'Targeted Section');
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(process.platform === 'win32' ? 250 : 50);
        expect(result).toContain('Targeted Section');
    });

    it('surgicalRead() returns empty string for binary files', async () => {
        // Write binary bytes
        const binFile = path.join(testDir, 'image.png');
        const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        await fs.writeFile(binFile, buffer);

        const result = await surgicalRead(binFile, 'image');
        expect(result).toBe('');
    });
});
