import { describe, it, expect } from 'vitest';
import { applySearchReplaceBlocks } from '../src/tools/coding-agents/patch-gen.js';

// From the traced cross-file demo with Qwythos 9B (a thinking model):
// 1. its reasoning filled the 2048-token reply budget, so 4 replies came back with empty content (~42 s each);
// 2. the additive anchor guard rejected correct blocks, because "Add multi-currency support" changes a
//    signature: formatPrice(cents) -> formatPrice(cents, currency = 'USD') was counted as a dropped line.

describe('additive anchor guard', () => {
    const FILE = "function formatPrice(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}\n";

    it('a modified line (same declaration, new parameter) is not a dropped line', () => {
        const r = applySearchReplaceBlocks(FILE, [{
            search: 'function formatPrice(cents) {',
            replace: "const SYMBOLS = { USD: '$' };\nfunction formatPrice(cents, currency = 'USD') {",
        }], { additive: true });
        expect(r.failures).toEqual([]);
        expect(r.content).toContain("function formatPrice(cents, currency = 'USD') {");
    });

    it('a line that really disappears is still refused for an additive instruction', () => {
        const r = applySearchReplaceBlocks(FILE, [{
            search: "function formatPrice(cents) {\n  return '$' + (cents / 100).toFixed(2);",
            replace: 'function formatPrice(cents) {',
        }], { additive: true });
        expect(r.appliedCount).toBe(0);
        expect(r.failures[0]).toMatch(/anchor not retained/);
    });
});

describe('reply budget', () => {
    it('is short for SEARCH/REPLACE and scales with the excerpt for rewrites, within [1024, 8192]', async () => {
        const { replyBudget } = await import('../src/tools/local-llm-patch.js');
        expect(replyBudget(true, 'x'.repeat(50_000))).toBe(2048);
        expect(replyBudget(false, 'x'.repeat(300))).toBe(1024);
        const mid = replyBudget(false, 'x'.repeat(6_000));
        expect(mid).toBeGreaterThan(2_600);
        expect(mid).toBeLessThan(3_200);
        expect(replyBudget(false, 'x'.repeat(100_000))).toBe(8192);
    });
});
