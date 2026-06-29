import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { writeFileAtomic } from '../src/utils/FileUtils.js';

describe('FileUtils - Atomic Writes', () => {
    const testDir = path.resolve('./tests/temp-file-utils-test');
    const testFile = path.join(testDir, 'concurrency-test.json');

    afterAll(async () => {
        // Cleanup test directory
        try {
            await fs.rm(testDir, { recursive: true, force: true });
        } catch {}
    });

    it('should write file content successfully', async () => {
        const content = JSON.stringify({ hello: 'world' });
        await writeFileAtomic(testFile, content);
        
        const read = await fs.readFile(testFile, 'utf-8');
        expect(read).toBe(content);
    });

    it('should handle high-concurrency writes without corruption', async () => {
        const numWrites = 50;
        const writePromises: Promise<void>[] = [];

        // Spawn 50 parallel writes, each writing a distinct valid JSON object
        for (let i = 0; i < numWrites; i++) {
            const content = JSON.stringify({ id: i, payload: 'x'.repeat(1000) });
            writePromises.push(writeFileAtomic(testFile, content));
        }

        // Wait for all writes to finish
        await Promise.all(writePromises);

        // Read the final file
        const finalContent = await fs.readFile(testFile, 'utf-8');
        
        // Assert that the file is not corrupted (it must parse as valid JSON)
        const parsed = JSON.parse(finalContent);
        expect(parsed).toHaveProperty('id');
        expect(parsed).toHaveProperty('payload');
        expect(typeof parsed.id).toBe('number');
        expect(parsed.id).toBeGreaterThanOrEqual(0);
        expect(parsed.id).toBeLessThan(numWrites);
        expect(parsed.payload).toBe('x'.repeat(1000));
    });
});
