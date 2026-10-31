import { describe, it, expect } from 'vitest';
import { findUndocumentedKeys, findNewDocGaps, findClosedDocGaps } from '../scripts/verification/doc-sync.js';

// The reference docs once missed new result fields and settings because nothing compared them with the code.
// These helpers compare a TypeScript interface's keys with the documentation text.

const SRC = `
export interface Result {
  status?: 'a' | 'b';
  /** @internal not for callers */
  secret?: string;
  hypotheses?: Array<{ id: string }>;
  nested?: { inner: number };
  'quoted-key'?: boolean;
}
`;

describe('findUndocumentedKeys', () => {
    it('reports keys the doc never mentions', () => {
        const doc = 'interface Result {\n  status?: string;\n}';
        expect(findUndocumentedKeys(SRC, 'Result', doc)).toEqual(['hypotheses', 'nested', 'quoted-key']);
    });
    it('is satisfied by a field declaration or a quoted settings key', () => {
        const doc = 'status?: x;\nhypotheses?: y;\n"nested": 1\n"quoted-key": true';
        expect(findUndocumentedKeys(SRC, 'Result', doc)).toEqual([]);
    });
    it('a key that is only a substring of another word does not count', () => {
        expect(findUndocumentedKeys(SRC, 'Result', 'statuses and hypothesesFile and nestedness')).toEqual(['status', 'hypotheses', 'nested', 'quoted-key']);
    });
    it('an interface that is not found reports nothing rather than everything', () => {
        expect(findUndocumentedKeys(SRC, 'Nope', 'x')).toEqual([]);
    });
    it('@internal keys are exempt', () => {
        expect(findUndocumentedKeys(SRC, 'Result', '')).not.toContain('secret');
    });
});

describe('ratchet', () => {
    it('a key already on record is tolerated; a new undocumented key is reported', () => {
        const baseline = { Result: ['old'] };
        expect(findNewDocGaps({ Result: ['old'] }, baseline)).toEqual([]);
        expect(findNewDocGaps({ Result: ['old', 'fresh'] }, baseline)).toEqual(['Result.fresh is not in its reference doc']);
        expect(findNewDocGaps({ Other: ['x'] }, baseline)).toEqual(['Other.x is not in its reference doc']);
    });
    it('reports gaps that are now documented so the baseline can shrink', () => {
        expect(findClosedDocGaps({ Result: [] }, { Result: ['old'] })).toEqual(['Result.old']);
        expect(findClosedDocGaps({ Result: ['old'] }, { Result: ['old'] })).toEqual([]);
    });
});
