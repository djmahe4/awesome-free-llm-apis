import { describe, it, expect } from 'vitest';
import { searchReplaceRegressesTsErrors } from '../src/tools/coding-agents/patch-gen.js';

// Found by tracing a 6-line edit that took 6 minutes: the in-memory TS check cannot resolve any import,
// so an edit that ADDS an import counted as "one more error", the correct search/replace edit was thrown
// away and the 7B model regenerated the whole 611-line file instead (126 s per attempt).
const BEFORE = [
    "import { helper } from './helper.js';",
    'export function run(x: number) {',
    '    return helper(x);',
    '}',
].join('\n');

describe('search/replace TypeScript gate', () => {
    it('a correct edit that adds a relative import is not a regression', async () => {
        const after = BEFORE
            .replace("import { helper } from './helper.js';", "import { helper } from './helper.js';\nimport { check } from './check.js';")
            .replace('    return helper(x);', '    if (!check(x)) return 0;\n    return helper(x);');
        expect(await searchReplaceRegressesTsErrors('src/run.ts', BEFORE, after)).toBe(false);
    });

    it('an edit that uses node globals is not a regression either', async () => {
        const after = BEFORE.replace('    return helper(x);', '    if (process.env.X) return 0;\n    return helper(x);');
        expect(await searchReplaceRegressesTsErrors('src/run.ts', BEFORE, after)).toBe(false);
    });

    it('a real syntax break is still caught', async () => {
        const after = BEFORE.replace('    return helper(x);', '    return helper(x;');
        expect(await searchReplaceRegressesTsErrors('src/run.ts', BEFORE, after)).toBe(true);
    });

    it('a real type error in local code is still caught', async () => {
        const after = BEFORE.replace('    return helper(x);', '    const n: number = "text";\n    return helper(x);');
        expect(await searchReplaceRegressesTsErrors('src/run.ts', BEFORE, after)).toBe(true);
    });
});
