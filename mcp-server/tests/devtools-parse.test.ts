import { describe, it, expect } from 'vitest';
import { parseDevToolsResult, evaluateStructured } from '../src/browser/DevToolsCall.js';
import { FakeDevToolsClient } from '../src/browser/DevToolsClient.js';

describe('parseDevToolsResult', () => {
    it('parses a ```json fenced markdown array (the shape smoke scripts regexed by hand)', () => {
        const raw = { content: [{ type: 'text', text: '```json\n[{"a":1}]\n```' }] };
        const res = parseDevToolsResult(raw);
        expect(res.ok).toBe(true);
        expect(res.json).toEqual([{ a: 1 }]);
    });

    it('unwraps a double-encoded JSON string', () => {
        const raw = { content: [{ type: 'text', text: '```json\n"[{\\"a\\":1}]"\n```' }] };
        const res = parseDevToolsResult(raw);
        expect(res.ok).toBe(true);
        expect(res.json).toEqual([{ a: 1 }]);
    });

    it('parses bare JSON with no fence', () => {
        const raw = { content: [{ type: 'text', text: '{"ok":true}' }] };
        const res = parseDevToolsResult(raw);
        expect(res.ok).toBe(true);
        expect(res.json).toEqual({ ok: true });
    });

    it('reports a structured failure instead of throwing on garbage input', () => {
        const raw = { content: [{ type: 'text', text: 'not json at all' }] };
        const res = parseDevToolsResult(raw);
        expect(res.ok).toBe(false);
        expect(res.error).toBeTruthy();
    });

    it('reports empty-response failure without throwing', () => {
        const res = parseDevToolsResult({ content: [] });
        expect(res.ok).toBe(false);
    });
});

describe('evaluateStructured', () => {
    it('returns typed data on success and never puts raw args into source', async () => {
        const marker = 'user-supplied<script>';
        const client = new FakeDevToolsClient(async (req) => {
            // Simulate chrome-devtools-mcp: evaluate the function expression,
            // call it, then JSON.stringify the result.
            expect(req.name).toBe('evaluate_script');
            const src = req.arguments?.function as string;
            expect(src).toContain('__bt');
            expect(src).not.toContain(marker);
            expect(req.arguments?.args).toBeUndefined();
            const fn = await new Function(`return (${src})`)();
            const result = await fn();
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        });

        const res = await evaluateStructured(client, `(a) => a`, { value: marker });
        expect(res.ok).toBe(true);
        expect(res.json).toEqual({ value: marker });
    });

    it('round-trips non-ASCII args through the base64 transport', async () => {
        const client = new FakeDevToolsClient(async (req) => {
            const fn = await new Function(`return (${req.arguments?.function})`)();
            return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
        });
        const res = await evaluateStructured(client, `(a) => a`, { text: 'héllo — ✓ 日本語' });
        expect(res.ok).toBe(true);
        expect(res.json).toEqual({ text: 'héllo — ✓ 日本語' });
    });

    it('surfaces an in-page throw as a typed error instead of an empty catch', async () => {
        const client = new FakeDevToolsClient(async (req) => {
            const fn = await new Function(`return (${req.arguments?.function})`)();
            return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
        });
        const res = await evaluateStructured(client, `() => { throw new Error('boom'); }`);
        expect(res.ok).toBe(false);
        expect(res.error).toBe('boom');
    });
});
