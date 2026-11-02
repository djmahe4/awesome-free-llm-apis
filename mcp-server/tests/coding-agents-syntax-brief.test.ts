import { describe, it, expect } from 'vitest';
import { buildSyntaxBrief } from '../src/tools/coding-agents/verify-guard.js';

// Issue #114: the isolated per-file check has no node_modules and no sibling files, so every import looks unresolved.
// Those messages led a retry brief ("Cannot find name 'node:fs/promises'") and the real parse error, a string broken
// across two lines, was further down or cut off. A 7B model read the first lines and repeated its edit four times.

const err = (message: string, line?: number, filePath = 'src/a.ts') => ({ filePath, line, message, severity: 'error' });

describe('buildSyntaxBrief lists parse errors, not unresolved imports', () => {
    it('leaves out module and type resolution errors and keeps the parse error', () => {
        const brief = buildSyntaxBrief([
            err("Cannot find name 'node:fs/promises'. Do you need to install type definitions for node?", 1),
            err("Cannot find name 'node:path'. Do you need to install type definitions for node?", 2),
            err("Cannot find module './types.js' or its corresponding type declarations.", 3),
            err('Unterminated string literal.', 41),
        ]);
        expect(brief).toMatch(/src\/a\.ts:41 Unterminated string literal/);
        expect(brief).not.toMatch(/node:fs\/promises|node:path|Cannot find module/);
    });
    it('keeps every kind of parse error, in file order', () => {
        const brief = buildSyntaxBrief([
            err("',' expected.", 7),
            err('Declaration or statement expected.', 12),
            err("'}' expected.", 30),
            err('Expression expected.', 31),
        ]);
        for (const m of ["',' expected", 'Declaration or statement expected', "'}' expected", 'Expression expected']) expect(brief).toContain(m);
        expect(brief.indexOf("',' expected")).toBeLessThan(brief.indexOf("'}' expected"));
    });
    it('says nothing when the only errors are unresolved names and modules', () => {
        expect(buildSyntaxBrief([
            err("Cannot find name 'node:fs/promises'.", 1),
            err("Cannot find module './types.js' or its corresponding type declarations.", 3),
            err("Cannot find name 'require'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.", 5),
        ])).toBe('');
    });
    it('still ignores warnings', () => {
        expect(buildSyntaxBrief([{ filePath: 'a.ts', line: 1, message: 'Unterminated string literal.', severity: 'warning' }])).toBe('');
    });
    it('counts what it left out so the model is not told there were no other errors', () => {
        const brief = buildSyntaxBrief([err("Cannot find module './x.js'.", 1), err('Unterminated string literal.', 9)]);
        expect(brief).toMatch(/unresolved import|module resolution/i);
    });
    it('caps the list at ten and says how many more there are', () => {
        const many = Array.from({ length: 13 }, (_, i) => err("',' expected.", i + 1));
        const brief = buildSyntaxBrief(many);
        expect(brief.match(/expected/g)?.length).toBeGreaterThanOrEqual(10);
        expect(brief).toMatch(/\+3 more/);
    });
});
