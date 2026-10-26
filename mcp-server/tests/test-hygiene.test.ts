import { describe, it, expect } from 'vitest';
import { findTempHygieneProblems, findRetrylessRemovals } from '../scripts/verification/test-hygiene.js';

describe('temp-dir hygiene check', () => {
    const f = (content: string, p = 'tests/x.test.ts') => [{ path: p, content }];

    it('flags a test that writes under the temp dir and never removes anything', () => {
        const src = "const d = await fs.mkdtemp(path.join(os.tmpdir(), 'x-'));\nawait fs.writeFile(path.join(d, 'a'), '1');";
        expect(findTempHygieneProblems(f(src))).toHaveLength(1);
    });

    it('accepts removal by removeDir, fs.rm or fs.remove', () => {
        for (const rm of ['afterAll(() => removeDir(d));', 'await fs.rm(d, {});', 'await fs.remove(d);']) {
            expect(findTempHygieneProblems(f(`const d = await fs.mkdtemp(x);\nawait fs.writeFile(d, '1');\n${rm}`))).toHaveLength(0);
        }
    });

    it('ignores a file that only computes a temp path', () => {
        expect(findTempHygieneProblems(f("expect(getHome()).toBe(path.join(os.tmpdir(), 'custom'));"))).toHaveLength(0);
    });

    it('does not check the helpers folder', () => {
        expect(findTempHygieneProblems(f('fs.mkdtemp(x); fs.writeFile(y)', 'tests/helpers/a.ts'))).toHaveLength(0);
    });

    it('reports a single-attempt recursive removal in a file that makes temp dirs', () => {
        const once = findRetrylessRemovals(f("const d = await fs.mkdtemp(x);\nawait fs.rm(d, { recursive: true, force: true });"));
        expect(once).toHaveLength(1);
        expect(findRetrylessRemovals(f("const d = await fs.mkdtemp(x);\nawait fs.rm(d, { recursive: true, force: true, maxRetries: 10 });"))).toHaveLength(0);
    });
});
