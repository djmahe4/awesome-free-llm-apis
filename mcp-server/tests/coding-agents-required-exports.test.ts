import { describe, it, expect } from 'vitest';
import { requiredExports, missingExports } from '../src/tools/coding-agents/required-exports.js';
import { buildRepairBrief } from '../src/tools/coding-agents/verify-guard.js';

// A goal said "creates a module that exports `a`, `b` and `c`"; the local model wrote them without `export`, every test
// failed, and nothing told it why. The names a goal requires are known before the model runs, so they can be checked
// on its answer before any test runs, and named in the brief when they are missing.

describe('requiredExports reads the names a goal says a module exports', () => {
    it('takes the declared name from each code span after "exports"', () => {
        const goal = "Create src/x.ts that exports `type A = 'a' | 'b'`, `interface B { x: number }` and `function c(input: string): string`.";
        expect(requiredExports(goal)).toEqual(['A', 'B', 'c']);
    });
    it('takes a bare identifier as it is', () => {
        expect(requiredExports('The module exports `sanitizeText`.')).toEqual(['sanitizeText']);
        expect(requiredExports('It should export `Foo` and `bar`')).toEqual(['Foo', 'bar']);
    });
    it('understands const, let, class, enum and async function declarations', () => {
        expect(requiredExports('exports `const LIMIT = 5`, `class Box`, `enum Color`, `async function load()`')).toEqual(['LIMIT', 'Box', 'Color', 'load']);
    });
    it('only reads the sentence that says exports; other code spans are not required', () => {
        expect(requiredExports('Create x that exports `a` and `b`. It calls `helper` internally.')).toEqual(['a', 'b']);
    });
    it('a dot inside a code span does not end the sentence', () => {
        expect(requiredExports('It exports `function f(a = 1.5)` and `g`.')).toEqual(['f', 'g']);
    });
    it('returns nothing when the goal does not say anything is exported', () => {
        expect(requiredExports('Fix `getUser` so it caches results')).toEqual([]);
        expect(requiredExports('')).toEqual([]);
    });
    it('lists each name once', () => {
        expect(requiredExports('exports `a`, `a` and `function a()`')).toEqual(['a']);
    });
});

describe('missingExports lists the required names a file does not export', () => {
    it('finds names that are declared but not exported, and names not declared at all', () => {
        const content = 'export function a() {}\nfunction b() {}\nexport const c = 1;\nexport { d };\nconst d = 2;\n';
        expect(missingExports(content, ['a', 'b', 'c', 'd', 'e'])).toEqual(['b', 'e']);
    });
    it('counts export type, interface, class, enum and async function', () => {
        const content = 'export type A = 1;\nexport interface B {}\nexport class C {}\nexport enum D { X }\nexport async function f() {}\n';
        expect(missingExports(content, ['A', 'B', 'C', 'D', 'f'])).toEqual([]);
    });
    it('counts a name in an export list, with or without an alias', () => {
        expect(missingExports('const a = 1;\nconst b = 2;\nexport { a, b as c };\n', ['a', 'b', 'c'])).toEqual(['b']);
    });
    it('a default export does not satisfy a named export', () => {
        expect(missingExports('export default function g() {}\n', ['g'])).toEqual(['g']);
    });
    it('a commented-out export does not count', () => {
        expect(missingExports('// export function z() {}\n/* export const y = 1; */\n', ['z', 'y'])).toEqual(['z', 'y']);
    });
    it('a longer name does not satisfy a shorter one', () => {
        expect(missingExports('export function sanitizeTextAll() {}\n', ['sanitizeText'])).toEqual(['sanitizeText']);
    });
    it('returns nothing when no names are required', () => {
        expect(missingExports('anything', [])).toEqual([]);
    });
});

describe('the repair brief names the missing exports', () => {
    it('says which names the goal requires and the edit does not export', () => {
        const brief = buildRepairBrief({ command: 'npx vitest run t.test.ts', exitCode: 1, outputTail: '', patchedFiles: ['src/x.ts'], failedCases: ['a', 'b'], missingExports: ['sanitizeText', 'SanitizeFlag'] });
        expect(brief).toMatch(/does not export[\s\S]*sanitizeText[\s\S]*SanitizeFlag/);
        expect(brief).toMatch(/export keyword/i);
    });
    it('is silent when nothing is missing', () => {
        const brief = buildRepairBrief({ command: 'c', exitCode: 1, outputTail: '', patchedFiles: [], failedCases: ['a'], missingExports: [] });
        expect(brief).not.toMatch(/does not export/);
    });
});

describe('exportGaps combines the goal and the files an edit produced', () => {
    // imported here so the first two describes above still run while this helper is being written
    const load = async () => (await import('../src/tools/coding-agents/required-exports.js')) as { exportGaps?: (goal: string, files: Array<{ filePath: string; content: string }>) => string[] };

    it('lists required names that no code file exports', async () => {
        const { exportGaps } = await load();
        const goal = 'Create x that exports `function a()` and `function b()`.';
        expect(exportGaps?.(goal, [{ filePath: 'src/x.ts', content: 'export function a() {}\nfunction b() {}\n' }])).toEqual(['b']);
    });
    it('a name exported by any one of several files is satisfied', async () => {
        const { exportGaps } = await load();
        const goal = 'It exports `a` and `b`.';
        const files = [{ filePath: 'src/a.ts', content: 'export const a = 1;' }, { filePath: 'src/b.ts', content: 'export const b = 2;' }];
        expect(exportGaps?.(goal, files)).toEqual([]);
    });
    it('ignores files that are not TypeScript or JavaScript', async () => {
        const { exportGaps } = await load();
        expect(exportGaps?.('It exports `a`.', [{ filePath: 'README.md', content: 'nothing' }])).toEqual([]);
        expect(exportGaps?.('It exports `a`.', [{ filePath: 'x.py', content: 'def a(): pass' }])).toEqual([]);
    });
    it('is empty when the goal requires nothing', async () => {
        const { exportGaps } = await load();
        expect(exportGaps?.('Fix `getUser`', [{ filePath: 'x.ts', content: 'function getUser() {}' }])).toEqual([]);
    });
});
