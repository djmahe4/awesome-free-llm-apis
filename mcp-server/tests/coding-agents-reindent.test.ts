import { describe, it, expect } from 'vitest';
import { applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';
import { buildRepairBrief } from '../src/tools/coding-agents/verify-guard.js';

// Observed live: the model copies a block with the wrong indentation, the whitespace-tolerant matcher
// still finds it, and the replacement then lands 4 spaces too deep in the file.
const FILE = [
    'function outer() {',
    '    if (flag) {',
    '        doWork();',
    '    }',
    '}',
].join('\n');

describe('applySearchReplaceBlocks re-indents the replacement to the matched block', () => {
    it('SEARCH and REPLACE indented deeper than the file: replacement is shifted back', () => {
        const r = applySearchReplaceBlocks(FILE, [{
            search: '        if (flag) {\n            doWork();\n        }',
            replace: '        if (flag) {\n            doWork();\n            logIt();\n        }',
        }]);
        expect(r.failures).toEqual([]);
        expect(r.content).toBe([
            'function outer() {',
            '    if (flag) {',
            '        doWork();',
            '        logIt();',
            '    }',
            '}',
        ].join('\n'));
    });

    it('SEARCH and REPLACE indented shallower than the file: replacement is shifted in', () => {
        const r = applySearchReplaceBlocks(FILE, [{
            search: 'if (flag) {\n    doWork();\n}',
            replace: 'if (flag) {\n    doWork();\n    logIt();\n}',
        }]);
        expect(r.failures).toEqual([]);
        expect(r.content).toBe([
            'function outer() {',
            '    if (flag) {',
            '        doWork();',
            '        logIt();',
            '    }',
            '}',
        ].join('\n'));
    });

    it('exact indentation is untouched, including a REPLACE that intentionally re-indents lines', () => {
        const r = applySearchReplaceBlocks(FILE, [{
            search: '    if (flag) {\n        doWork();\n    }',
            replace: '    while (flag) {\n        doWork();\n    }',
        }]);
        expect(r.content).toBe(FILE.replace('if (flag)', 'while (flag)'));
    });

    it('does not shift when the SEARCH indentation delta is not uniform', () => {
        const r = applySearchReplaceBlocks(FILE, [{
            search: '  if (flag) {\n          doWork();\n  }',
            replace: '  if (flag) {\n          doWork();\n          logIt();\n  }',
        }]);
        // not uniform: leave the replacement exactly as the model wrote it rather than guess
        if (r.failures.length === 0) {
            expect(r.content).toContain('\n          logIt();\n');
        }
    });
});

describe('repair brief for a numeric mismatch', () => {
    it('tells the model to re-check what the functions it calls return', () => {
        const brief = buildRepairBrief({
            command: 'npx vitest run tests/x.test.ts', exitCode: 1, timedOut: false, patchedFiles: ['src/a.ts'],
            failedCases: ['reports how many entries it discarded'],
            outputTail: 'AssertionError: expected 3 to be +0 // Object.is equality\n- Expected\n+ Received\n- 0\n+ 3',
        } as any);
        expect(brief).toMatch(/what (the )?(functions|calls?) (you call|it calls)? ?return/i);
    });

    it('does not add that hint to unrelated failures', () => {
        const brief = buildRepairBrief({
            command: 'node --test t.js', exitCode: 1, timedOut: false, patchedFiles: ['src/a.js'],
            failedCases: ['x'], outputTail: 'TypeError: foo is not a function',
        } as any);
        expect(brief).not.toMatch(/return/i);
    });
});
