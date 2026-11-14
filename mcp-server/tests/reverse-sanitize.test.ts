import { describe, it, expect } from 'vitest';
import { sanitizeText } from '../src/reverse/sanitize.js';

// Output from an analysis engine describes untrusted samples. sanitizeText removes what hides or reorders text,
// cuts long encoded blobs, caps the length, and reports what it did. It returns { text, flags }.

describe('sanitizeText', () => {
    it('leaves ordinary text, tabs and newlines alone and reports no flags', () => {
        const r = sanitizeText('line one\n\tline two {"a":1}');
        expect(r.text).toBe('line one\n\tline two {"a":1}');
        expect(r.flags).toEqual([]);
    });
    it('removes control characters and ANSI escapes and flags control_chars', () => {
        const r = sanitizeText('a\u0000b\u001b[31mred\u001b[0m\u0007c');
        expect(r.text).toBe('abredc');
        expect(r.flags).toContain('control_chars');
    });
    it('removes zero-width characters and flags zero_width', () => {
        const r = sanitizeText('ig​no‍re﻿');
        expect(r.text).toBe('ignore');
        expect(r.flags).toContain('zero_width');
    });
    it('removes bidirectional overrides and isolates and flags bidi', () => {
        const r = sanitizeText('abc‮def⁦ghi‏');
        expect(r.text).toBe('abcdefghi');
        expect(r.flags).toContain('bidi');
    });
    it('replaces a long base64 run with a marker and flags long_base64', () => {
        const blob = 'QUJD'.repeat(100);
        const r = sanitizeText(`before ${blob} after`);
        expect(r.text).not.toContain(blob);
        expect(r.text).toMatch(/^before \[encoded blob of 400 characters removed\] after$/);
        expect(r.flags).toContain('long_base64');
    });
    it('does not treat a short base64-looking word as a blob', () => {
        const r = sanitizeText('token QUJDRA== ok');
        expect(r.text).toBe('token QUJDRA== ok');
        expect(r.flags).toEqual([]);
    });
    it('caps the length, appends a truncation note and flags truncated', () => {
        const r = sanitizeText('x'.repeat(50), 20);
        expect(r.text.startsWith('x'.repeat(20))).toBe(true);
        expect(r.text).toMatch(/\[truncated at 20 characters\]$/);
        expect(r.flags).toContain('truncated');
    });
    it('reports every flag that applies, once each', () => {
        const r = sanitizeText('a\u0000\u0001b​‮');
        expect([...r.flags].sort()).toEqual(['bidi', 'control_chars', 'zero_width']);
    });
    it('accepts non-strings without throwing', () => {
        expect(sanitizeText(undefined as unknown as string).text).toBe('');
        expect(sanitizeText(null as unknown as string).text).toBe('');
    });
});

describe('flags say what was removed, not what changed', () => {
    it('normalising Unicode alone raises no flag', () => {
        const r = sanitizeText('é');
        expect(r.text).toBe('é');
        expect(r.flags).toEqual([]);
    });
    it('a missing input gives an empty text and no flag', () => {
        expect(sanitizeText(undefined as unknown as string)).toEqual({ text: '', flags: [] });
        expect(sanitizeText(null as unknown as string)).toEqual({ text: '', flags: [] });
    });
    it('tabs and newlines are kept and raise no flag', () => {
        expect(sanitizeText('a\tb\nc')).toEqual({ text: 'a\tb\nc', flags: [] });
    });
    it('a long run of base64 without padding is replaced, with its length', () => {
        const r = sanitizeText('x ' + 'A'.repeat(200) + ' y');
        expect(r.text).toBe('x [encoded blob of 200 characters removed] y');
        expect(r.flags).toEqual(['long_base64']);
    });
    it('199 base64 characters are left alone', () => {
        const run = 'A'.repeat(199);
        expect(sanitizeText(run)).toEqual({ text: run, flags: [] });
    });
    it('the truncation note is added once and the cap applies after the other changes', () => {
        const r = sanitizeText('ab​cd'.repeat(10), 20);
        expect(r.flags).toEqual(['zero_width', 'truncated']);
        expect(r.text.startsWith('abcd'.repeat(5))).toBe(true);
        expect(r.text.endsWith('\n[truncated at 20 characters]')).toBe(true);
    });
});
