import { describe, expect, it } from 'vitest';
import { extractCallSites, formatCallSites, splitArgs, validateContractBullets } from '../src/tools/coding-agents/call-sites.js';

const TEST = `
import { buildThing, readThing } from '../src/mod.js';
it('builds', () => {
  const dag = buildThing('s1', 'Reader task', { messages: [
    { User: { content: [{ Text: 'Implement, reader' }] } },
    { Agent: { content: [{ ToolUse: { id: 'tc', name: 'Read' } }] } },
  ] });
  expect(readThing(db, workspace).map(s => s.id)).toEqual(['thread-1']);
  expect(typeof obj.buildThing(1)).toBe('function'); // a method call, not the export
});
function buildThing(a, b, c) {} // a declaration, not a call
`;

describe('splitArgs', () => {
  it('splits at top level only, keeping strings, objects and arrays whole', () => {
    expect(splitArgs(`'a, b', { x: [1, 2], y: "z,w" }, [3, 4], fn(1, 2)`)).toEqual([`'a, b'`, `{ x: [1, 2], y: "z,w" }`, `[3, 4]`, `fn(1, 2)`]);
    expect(splitArgs('')).toEqual([]);
  });
});

describe('extractCallSites', () => {
  const sites = extractCallSites(TEST, ['buildThing', 'readThing']);
  it('reads the literal call with its argument count and shape', () => {
    const build = sites.get('buildThing')!;
    expect(build).toHaveLength(1);
    expect(build[0].args).toHaveLength(3);
    expect(build[0].args[2].startsWith('{ messages: [')).toBe(true);
    expect(build[0].text).toContain("buildThing('s1', 'Reader task', { messages: [");
    expect(sites.get('readThing')![0].args).toEqual(['db', 'workspace']);
  });
  it('ignores method calls and declarations', () => {
    expect(sites.get('buildThing')!.every(c => !c.text.includes('(1)') && !c.text.includes('(a, b, c)'))).toBe(true);
  });
  it('de-duplicates, caps and truncates long calls', () => {
    const many = Array.from({ length: 8 }, (_, i) => `f(${i});`).join('\n') + '\nf(0);';
    expect(extractCallSites(many, ['f']).get('f')).toHaveLength(3);
    const long = extractCallSites(`g(${'x'.repeat(2000)})`, ['g']).get('g')![0];
    expect(long.text.length).toBeLessThan(500);
    expect(long.text.endsWith(' ...)')).toBe(true);
  });
  it('formats one bullet per call', () => {
    expect(formatCallSites(sites).split('\n')).toHaveLength(2);
    expect(formatCallSites(sites)).toContain('- called as readThing(db, workspace)');
  });
  it('copes with comments and template literals that contain brackets', () => {
    const s = extractCallSites('h(`a)b`, /* ) */ { k: 1 }); // trailing )', ['h']);
    expect(s.get('h')![0].args).toHaveLength(2);
  });
});

describe('validateContractBullets', () => {
  const sites = extractCallSites(TEST, ['buildThing', 'readThing']);
  it('drops the bullet that contradicts the call (the DeepSeek case: one array parameter for a three-argument call)', () => {
    const bad = '- buildThing(messages: any[]) returns a DAG object with nodes';
    const { kept, dropped } = validateContractBullets([bad], sites);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([bad]);
  });
  it('drops an array-typed parameter where the call passes an object literal, even with the right count', () => {
    const bad = '- buildThing(sessionId: string, goal: string, thread: Array) returns a DAG';
    expect(validateContractBullets([bad], sites).dropped).toEqual([bad]);
  });
  it('keeps a bullet that quotes the call, and bullets about names with no call site', () => {
    const good = "- buildThing('s1', 'Reader task', { messages: [ ... ] }) returns an object with a nodes array";
    const typed = '- buildThing(sessionId: string, goal: string, thread: { messages: Array }) returns a DAG';
    const other = '- scanThing(path) returns the schema';
    const r = validateContractBullets([good, typed, other], sites);
    expect(r.kept).toEqual([good, typed, other]);
    expect(r.dropped).toEqual([]);
  });
});
