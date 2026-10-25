import { describe, it, expect } from 'vitest';
import { unassignedMembers, buildRepairBrief } from '../src/tools/coding-agents/verify-guard.js';

// Traced: the 7B passed this.currency to formatPrice everywhere in cart.js but never assigned it, so every
// price fell back to USD and it stayed stuck on "cart uses its currency everywhere" for the whole budget.
// A member that is read but never assigned in the file is a cheap, general data-flow signal.

const CART = [
    'class Cart {',
    '  constructor() {',
    '    this.items = [];',
    '  }',
    '  summary() {',
    '    return this.items.map(i => formatPrice(i.cents, this.currency)).join(",");',
    '  }',
    '}',
].join('\n');

describe('unassignedMembers', () => {
    it('reports a this.member that is read but never assigned', () => {
        expect(unassignedMembers(CART)).toEqual(['currency']);
    });

    it('is quiet when the member is assigned (constructor, compound or destructured)', () => {
        expect(unassignedMembers(CART.replace('this.items = [];', 'this.items = [];\n    this.currency = currency;'))).toEqual([]);
        expect(unassignedMembers('class A { inc() { this.n += 1; return this.n; } }')).toEqual([]);
    });

    it('ignores method calls and members a class defines as methods or fields', () => {
        expect(unassignedMembers('class A { total() { return 1; } sum() { return this.total(); } }')).toEqual([]);
        expect(unassignedMembers('class A { size = 0; get() { return this.size; } }')).toEqual([]);
    });
});

describe('repair brief names unassigned members of the edited files', () => {
    it('adds the hint when given the file contents', () => {
        const brief = buildRepairBrief({
            command: 'node --test t.js', exitCode: 1, outputTail: "AssertionError: expected 'pen 3,00 €'", patchedFiles: ['src/cart.js'],
            failedCases: ['cart uses its currency everywhere'], fileContents: { 'src/cart.js': CART },
        } as any);
        expect(brief).toMatch(/src\/cart\.js reads this\.currency but never assigns it/);
    });
});
