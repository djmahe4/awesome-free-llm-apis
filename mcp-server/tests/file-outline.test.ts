import { describe, expect, it } from 'vitest';
import { FileStructureDag, generateFileOutline } from '../src/harness/file-outline.js';

describe('generateFileOutline', () => {
  it('extracts declarations and line ranges across TypeScript and Python', () => {
    const outline = generateFileOutline([
      'export class Reader {',
      '  async read() {',
      '    return true;',
      '  }',
      '}',
      '',
      'def parse(value):',
      '    return value',
    ].join('\n'), 'src/reader.ts');

    expect(outline.totalLines).toBe(8);
    expect(outline.outline.map(item => [item.name, item.line, item.endLine])).toEqual([
      ['Reader', 1, 1],
      ['read', 2, 6],
      ['parse', 7, 8],
    ]);
    expect(outline.outline[1].parentId).toBe('src/reader.ts#1:Reader');
  });
});

describe('FileStructureDag', () => {
  it('replaces stale file and symbol nodes when source changes', () => {
    const dag = new FileStructureDag();
    dag.updateFile('src/reader.ts', 'export function oldReader() {}');
    dag.updateFile('src/reader.ts', 'export function newReader() {}');

    expect(dag.getNodes('src/reader.ts').map(node => node.name)).toEqual(['src/reader.ts', 'newReader']);
    expect(dag.getFileOutline('src/reader.ts')?.outline[0].name).toBe('newReader');
    expect(dag.render(['src/reader.ts'])).toContain('newReader');
    expect(dag.render(['src/reader.ts'])).not.toContain('oldReader');
  });

  it('does not rebuild unchanged content', () => {
    const dag = new FileStructureDag();
    const first = dag.updateFile('a.ts', 'function run() {}');
    const second = dag.updateFile('a.ts', 'function run() {}');
    expect(second).toBe(first);
    expect(dag.getNodes()).toHaveLength(2);
  });
});
