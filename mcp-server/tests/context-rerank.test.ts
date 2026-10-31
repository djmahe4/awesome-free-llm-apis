import { describe, it, expect, vi } from 'vitest';
import { rerankFiles, scoreFiles, rerankEnabled } from '../src/pipeline/middlewares/rerank.js';

// Slice 6: a file holding the goal's rare terms beats files that share only its common words.

const lines = (...c: string[]) => c.map((content, i) => ({ line: i + 1, content }));
const common = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `src/mod_${String(i).padStart(2, '0')}.ts`, lines: lines('apply discount to order total') }));
const tier = (f: string) => (f.startsWith('src/') ? 0.5 : 1);

describe('rerankFiles', () => {
    it('puts the file with the distinctive term first even when it sorts last', () => {
        const entries = [...common(30), { file: 'src/zz/loyalty.ts', lines: lines('function applyloyaltydiscount(order) {}') }];
        const out = rerankFiles(entries, ['apply', 'discount', 'order', 'applyloyaltydiscount'], tier);
        expect(out[0]).toBe('src/zz/loyalty.ts');
    });
    it('a term found in the path counts for more than one found in the text', () => {
        const entries = [{ file: 'src/a.ts', lines: lines('payments here') }, { file: 'src/payments.ts', lines: lines('nothing') }];
        expect(rerankFiles(entries, ['payments'], tier)[0]).toBe('src/payments.ts');
    });
    it('an explicitly named file (tier 0) always stays first', () => {
        const entries = [{ file: 'named.ts', lines: lines('x') }, { file: 'src/rare.ts', lines: lines('rareterm rareterm') }];
        expect(rerankFiles(entries, ['rareterm'], f => (f === 'named.ts' ? 0 : 0.5))[0]).toBe('named.ts');
    });
    it('equal scores fall back to the old tier, then the name', () => {
        const entries = [{ file: 'lib/b.ts', lines: lines('x') }, { file: 'src/b.ts', lines: lines('x') }, { file: 'src/a.ts', lines: lines('x') }];
        expect(rerankFiles(entries, ['x'], tier)).toEqual(['src/a.ts', 'src/b.ts', 'lib/b.ts']);
    });
    it('no terms or no files does not throw and keeps every file', () => {
        expect(rerankFiles([], ['a'], tier)).toEqual([]);
        expect(rerankFiles(common(3), [], tier)).toHaveLength(3);
    });
});

describe('scoreFiles', () => {
    it('weights a term by how few files hold it', () => {
        const s = scoreFiles([{ file: 'a', lines: lines('rare common') }, { file: 'b', lines: lines('common') }, { file: 'c', lines: lines('common') }], ['rare', 'common']);
        expect(s.get('a')!).toBeGreaterThan(s.get('b')!);
        expect(s.get('b')).toBeCloseTo(s.get('c')!);
    });
    it('is case-insensitive', () => {
        const s = scoreFiles([{ file: 'a', lines: lines('LoyaltyTier') }], ['loyaltytier']);
        expect(s.get('a')!).toBeGreaterThan(0);
    });
});

describe('CONTEXT_RERANK switch', () => {
    it('is on by default and off when set to off', () => {
        expect(rerankEnabled()).toBe(true);
        vi.stubEnv('CONTEXT_RERANK', 'off'); expect(rerankEnabled()).toBe(false);
        vi.unstubAllEnvs();
    });
});
