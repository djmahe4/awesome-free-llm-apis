import { describe, it, expect } from 'vitest';
import { extractWindowForInstruction } from '../src/tools/coding-agents/patch-gen.js';

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`);

describe('extractWindowForInstruction: instructions that add something new', () => {
  it('no instruction term occurs in the file: does not fall back to the file head', () => {
    // 600 lines of noise, then the module's last real declaration, then a short tail.
    const lines = [
      '// header',
      "import fs from 'node:fs';",
      ...filler(600, 'noise'),
      'export function lastExisting() {',
      '  return 1;',
      '}',
      ...filler(20, 'tail'),
    ];
    const r = extractWindowForInstruction(lines.join('\n'), 'implement zzzbrandnew helper that normalizes widgets', 120);
    expect(r).not.toBeNull();
    expect(r!.window).not.toContain('// header');
    expect(r!.window).toContain('export function lastExisting');
  });

  it('names a class that exists: the window is that class, even when a common word is dense elsewhere', () => {
    const decoy = Array.from({ length: 60 }, (_, i) => `// method ${i}: this method calls another method`);
    const lines = [
      ...filler(100, 'a'),
      ...decoy,
      ...filler(100, 'b'),
      'export class TargetClass {',
      '  private count = 0;',
      '  increment() { this.count += 1; }',
      '}',
      ...filler(100, 'c'),
    ];
    const r = extractWindowForInstruction(lines.join('\n'), 'add a method zzzNew to class TargetClass that resets count', 60);
    expect(r).not.toBeNull();
    expect(r!.window).toContain('export class TargetClass');
    expect(r!.window).toContain('increment()');
  });

  it('an identifier match on a declaration line beats several plain mentions elsewhere', () => {
    const lines = [
      ...Array.from({ length: 50 }, () => '  // applyDiscount is used here'),
      ...filler(200, 'x'),
      'function applyDiscount(total: number) {',
      '  return total * 0.9;',
      '}',
      ...filler(200, 'y'),
    ];
    const r = extractWindowForInstruction(lines.join('\n'), 'change applyDiscount to cap the discount at 20', 50);
    expect(r!.window).toContain('function applyDiscount(total');
  });

  it('small files still return null (no window needed)', () => {
    expect(extractWindowForInstruction('a\nb\nc', 'add something here', 120)).toBeNull();
  });
});
