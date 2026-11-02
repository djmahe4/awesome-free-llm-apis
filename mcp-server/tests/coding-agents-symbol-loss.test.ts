import { describe, it, expect } from 'vitest';
import { lostSymbols } from '../src/tools/coding-agents/symbol-loss.js';

// #147: an insert replaced the function next to it, the check stayed green, and the tree stopped compiling.

const BEFORE = [
    'export function missingLiterals(a: string) {',
    '  const inner = 1;',
    '  return a;',
    '}',
    'function helper() {}',
    'export const LIMIT = 5;',
    'export class Store {}',
    'export interface Shape {}',
    'export type Kind = string;',
].join('\n');

describe('lostSymbols', () => {
    it('reports a top-level declaration the edit removed', () => {
        const after = BEFORE.replace('export function missingLiterals(a: string) {', 'export function alreadyAdded(a: string) {');
        expect(lostSymbols('a.ts', BEFORE, after, 'Add a function alreadyAdded')).toEqual(['missingLiterals']);
    });
    it('covers private functions, classes, constants, interfaces and types', () => {
        expect(lostSymbols('a.ts', BEFORE, '', 'Tidy the file')).toEqual(['missingLiterals', 'helper', 'LIMIT', 'Store', 'Shape', 'Kind']);
    });
    it('allows a removal the goal names', () => {
        expect(lostSymbols('a.ts', BEFORE, BEFORE.replace('function helper() {}', ''), 'Delete helper, it is unused')).toEqual([]);
    });
    it('does not count a name that only moved or lost its export keyword', () => {
        expect(lostSymbols('a.ts', BEFORE, BEFORE.replace('export const LIMIT', 'const LIMIT'), 'x')).toEqual([]);
    });
    it('ignores indented names, which are not top-level', () => {
        expect(lostSymbols('a.ts', BEFORE, BEFORE.replace('  const inner = 1;\n', ''), 'x')).toEqual([]);
    });
    it('reads Python definitions', () => {
        expect(lostSymbols('a.py', 'def one():\n  pass\nclass Two:\n  pass\n', 'def one():\n  pass\n', 'x')).toEqual(['Two']);
    });
    it('leaves other file types and new files alone', () => {
        expect(lostSymbols('a.md', 'function x() {}', '', 'x')).toEqual([]);
        expect(lostSymbols('a.ts', '', 'export const a = 1;', 'x')).toEqual([]);
    });
});
