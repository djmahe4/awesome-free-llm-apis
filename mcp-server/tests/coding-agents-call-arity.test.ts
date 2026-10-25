import { describe, it, expect } from 'vitest';
import { inconsistentCalls, buildRepairBrief } from '../src/tools/coding-agents/verify-guard.js';

// Traced (P3 smoke): the 7B fixed the constructor and the total line but left the per-item call
// formatPrice(i.cents * i.qty) without the new currency argument, and stayed stuck on
// "cart uses its currency everywhere". A function called with different argument counts in the same
// edited file is a cheap signal that one call site was missed.

const CART = [
    "const { formatPrice } = require('./money');",
    'class Cart {',
    "  constructor(currency = 'USD') {",
    '    this.currency = currency;',
    '  }',
    '  summary() {',
    '    const lines = this.items.map(i => `${i.name}: ${formatPrice(i.cents * i.qty)}`);',
    '    lines.push(`Total: ${formatPrice(this.total(), this.currency)}`);',
    "    return lines.join('\\n');",
    '  }',
    '}',
].join('\n');

describe('inconsistentCalls', () => {
    it('reports a function called with different argument counts, with the lines', () => {
        expect(inconsistentCalls(CART)).toEqual([{ name: 'formatPrice', counts: [{ args: 1, lines: [7] }, { args: 2, lines: [8] }] }]);
    });

    it('counts top-level arguments only (nested calls, arrays, objects, strings with commas)', () => {
        const src = "f(g(1, 2), [3, 4], { a: 5, b: 6 }, 'x, y');\nf(1, 2, 3, 4);\n";
        expect(inconsistentCalls(src)).toEqual([]);
    });

    it('ignores declarations, keywords and method calls', () => {
        const src = 'function f(a) {}\nf(1);\nif (x) {}\nwhile (y) {}\nobj.m(1);\nobj.m(1, 2);\n';
        expect(inconsistentCalls(src)).toEqual([]);
    });

    it('works for Python too', () => {
        const py = 'def summary(self):\n    a = format_price(i.cents)\n    b = format_price(self.total(), self.currency)\n';
        expect(inconsistentCalls(py).map(c => c.name)).toEqual(['format_price']);
    });
});

describe('repair brief', () => {
    it('names the call that differs from the others', () => {
        const brief = buildRepairBrief({
            command: 'node --test t.js', exitCode: 1, outputTail: 'AssertionError', patchedFiles: ['src/cart.js'],
            failedCases: ['cart uses its currency everywhere'], fileContents: { 'src/cart.js': CART },
        } as any);
        expect(brief).toMatch(/src\/cart\.js calls formatPrice with 1 argument on line 7 but 2 arguments on line 8/);
    });
});

describe('maskNonCode keeps calls but not prose', () => {
    it('ignores call-like text in comments and ordinary strings, keeps template expressions', async () => {
        const { maskNonCode } = await import('../src/tools/coding-agents/verify-guard.js');
        const src = "// see formatPrice(a)\nconst s = 'line(s) and files(x)';\n/* block(1) */\nconst t = `text f(1) ${formatPrice(i.cents)} more g(2)`;\nreal(1, 2);\n";
        const masked = maskNonCode(src);
        expect(masked.split('\n').length).toBe(src.split('\n').length);
        expect(masked).not.toMatch(/see formatPrice|line\(s\)|block\(1\)|text f\(1\)|more g\(2\)/);
        expect(masked).toContain('formatPrice(i.cents)');
        expect(masked).toContain('real(1, 2)');
    });

    it('does not flag prose-in-strings as inconsistent calls', () => {
        const src = "const a = 'files(1)';\nconst b = 'files(1, 2)';\n// files(1, 2, 3)\n";
        expect(inconsistentCalls(src)).toEqual([]);
    });
});
