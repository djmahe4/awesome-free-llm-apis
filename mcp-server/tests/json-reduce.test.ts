import { describe, it, expect } from 'vitest';
import { reduceJson } from '../src/utils/json-reduce.js';

// A JSON result too large for a model's context used to be refused (http) or cut as raw text (evaluate), so the
// parts the caller needed were lost with the rest. reduceJson keeps the document valid and shrinks it to a
// budget: detail goes first, relevant items stay, and what was dropped is counted.

const len = (v: unknown) => JSON.stringify(v).length;
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, name: `product ${i}`, price: i * 1.5, blurb: 'lorem ipsum '.repeat(40) }));

describe('reduceJson: budget', () => {
    it('a value that already fits is returned as is', () => {
        const v = { a: 1, b: [1, 2, 3] };
        const r = reduceJson(v, { maxChars: 1000 });
        expect(r.value).toEqual(v);
        expect(r.info.reduced).toBe(false);
    });

    it('a large array shrinks under the budget, stays valid JSON, and counts what it dropped', () => {
        const r = reduceJson({ total: 5000, results: items(5000) }, { maxChars: 4000 });
        expect(len(r.value)).toBeLessThanOrEqual(4000);
        expect(() => JSON.parse(JSON.stringify(r.value))).not.toThrow();
        const results = (r.value as any).results as any[];
        expect(Array.isArray(results)).toBe(true);
        const marker = results[results.length - 1];
        expect(marker._of).toBe(5000);
        expect(marker._omitted).toBe(5000 - (results.length - 1));
        expect(r.info.reduced).toBe(true);
        expect(r.info.omittedItems).toBeGreaterThan(4000);
        expect((r.value as any).total).toBe(5000); // small fields survive untouched
    });

    it('long strings are cut with a marker that says how much', () => {
        const r = reduceJson({ text: 'x'.repeat(50_000) }, { maxChars: 2000 });
        expect(len(r.value)).toBeLessThanOrEqual(2000);
        expect((r.value as any).text).toMatch(/\+\d+ chars\]$/);
    });

    it('deep nesting is cut with a placeholder instead of being dumped', () => {
        let deep: any = { leaf: 'v'.repeat(500) };
        for (let i = 0; i < 12; i++) deep = { level: i, child: deep, pad: 'p'.repeat(300) };
        const r = reduceJson(deep, { maxChars: 1500 });
        expect(len(r.value)).toBeLessThanOrEqual(1500);
        expect(JSON.stringify(r.value)).toMatch(/\[object with \d+ keys/);
    });

    it('never exceeds the budget, even for an adversarial shape', () => {
        const wide: Record<string, unknown> = {};
        for (let i = 0; i < 2000; i++) wide[`key${i}`] = { a: 'y'.repeat(200), b: [1, 2, 3], c: { d: 'z'.repeat(200) } };
        for (const maxChars of [300, 1000, 5000]) {
            const r = reduceJson(wide, { maxChars });
            expect(len(r.value)).toBeLessThanOrEqual(maxChars);
        }
    });

    it('primitives and empty containers pass through', () => {
        expect(reduceJson('hello', { maxChars: 100 }).value).toBe('hello');
        expect(reduceJson(42, { maxChars: 100 }).value).toBe(42);
        expect(reduceJson([], { maxChars: 100 }).value).toEqual([]);
        expect(reduceJson(null, { maxChars: 100 }).value).toBeNull();
    });

    it('reducing a reduced value changes nothing', () => {
        const once = reduceJson({ results: items(2000) }, { maxChars: 3000 });
        const twice = reduceJson(once.value, { maxChars: 3000 });
        expect(twice.value).toEqual(once.value);
    });
});

describe('reduceJson: relevance', () => {
    it('keeps the items that match the query, wherever they are in the array', () => {
        const list = items(3000);
        list[2750] = { id: 2750, name: 'Quantum Widget Pro', price: 99, blurb: 'the needle in the haystack' };
        const r = reduceJson({ results: list }, { maxChars: 3000, query: 'quantum widget' });
        const kept = (r.value as any).results as any[];
        expect(kept.some(x => x.id === 2750)).toBe(true);
        expect(kept.length).toBeLessThan(40);
    });

    it('without a query the head of the array is kept, in order', () => {
        const r = reduceJson({ results: items(3000) }, { maxChars: 3000 });
        const kept = ((r.value as any).results as any[]).filter(x => x.id !== undefined);
        expect(kept.map(x => x.id)).toEqual(kept.map((_, i) => i));
    });
});

describe('reduceJson: select', () => {
    const doc = { meta: { total: 3, page: 1 }, items: [{ id: 1, name: 'a', price: 5, extra: 'x' }, { id: 2, name: 'b', price: 6, extra: 'y' }, { id: 3, name: 'c', extra: 'z' }] };

    it('projects only the requested paths, with * over arrays', () => {
        const r = reduceJson(doc, { maxChars: 10_000, select: ['items.*.name', 'items.*.price', 'meta.total'] });
        expect(r.value).toEqual({ meta: { total: 3 }, items: [{ name: 'a', price: 5 }, { name: 'b', price: 6 }, { name: 'c' }] });
        expect(r.info.selected).toBe(true);
    });

    it('a path that does not exist is ignored; nothing selected gives an empty object and says so', () => {
        const r = reduceJson(doc, { maxChars: 10_000, select: ['nope.deeper'] });
        expect(r.value).toEqual({});
        expect(r.info.note).toMatch(/matched nothing/i);
    });

    it('a numeric index and * over object values work', () => {
        expect(reduceJson(doc, { maxChars: 10_000, select: ['items.1.name'] }).value).toEqual({ items: [{ name: 'b' }] });
        expect(reduceJson({ a: { x: 1 }, b: { x: 2, y: 3 } }, { maxChars: 10_000, select: ['*.x'] }).value).toEqual({ a: { x: 1 }, b: { x: 2 } });
    });

    it('select happens before the budget: a projection that fits is not reduced further', () => {
        const big = { results: items(3000) };
        // the whole document is ~1.7 MB; the three thousand ids alone are ~40 KB, which fits a 60 KB budget
        expect(JSON.stringify(big).length).toBeGreaterThan(1_000_000);
        const r = reduceJson(big, { maxChars: 60_000, select: ['results.*.id'] });
        expect(r.info.reduced).toBe(false);
        expect(((r.value as any).results as any[]).length).toBe(3000);
    });
});
