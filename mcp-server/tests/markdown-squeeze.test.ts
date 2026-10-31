import { describe, it, expect } from 'vitest';
import { squeezeJsonReply } from '../src/utils/markdown.js';

// Issue #124: every reply had the newline after "}" or "]" and before "{" or "[" removed, to save tokens on JSON. That
// also glued code together ("}export function", "}  // comment") and flattened markdown. Only a reply that is
// entirely JSON is squeezed now.

describe('squeezeJsonReply', () => {
    it('leaves code alone, blank lines after a closing brace included', () => {
        const code = 'function a() {\n  if (x) {\n    y();\n  }\n\n  // second part\n  z();\n}\n\nexport function b() {\n  return 1;\n}';
        expect(squeezeJsonReply(code)).toBe(code);
    });
    it('leaves markdown with lists and links alone', () => {
        const md = '# Title\n\n- item [one](http://x)\n- item two\n\n[ref]: http://y\n';
        expect(squeezeJsonReply(md)).toBe(md.trim());
    });
    it('leaves a reply with a fenced code block alone', () => {
        const text = 'Here:\n\n```ts\nconst o = {\n  a: 1,\n};\n\n[1, 2].map(f);\n```\n\nDone.';
        expect(squeezeJsonReply(text)).toBe(text);
    });
    it('leaves text that only looks like JSON (invalid) alone', () => {
        const text = '{\n  not json\n}\n\n[also not]';
        expect(squeezeJsonReply(text)).toBe(text);
    });
    it('still compacts a reply that is entirely valid JSON', () => {
        const json = '[\n  {\n    "a": 1\n  },\n  {\n    "b": [\n      2\n    ]\n  }\n]';
        const out = squeezeJsonReply(json);
        expect(out.includes('}\n')).toBe(false);
        expect(JSON.parse(out)).toEqual(JSON.parse(json));
    });
    it('trims surrounding whitespace in every case', () => {
        expect(squeezeJsonReply('\n\n  hello  \n')).toBe('hello');
        expect(squeezeJsonReply('')).toBe('');
    });
});
