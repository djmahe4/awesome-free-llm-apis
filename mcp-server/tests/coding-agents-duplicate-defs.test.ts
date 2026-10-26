import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { newDuplicateDefinitions } from '../src/tools/coding-agents/duplicate-defs.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// Traced (Python currency, 7B): instead of editing invoice_line the model ADDED a second
//   def invoice_line(item, currency='USD')
// under the import and left the original one-argument definition below it. The later definition wins, so
// the old one kept overriding the new one: "invoice_line() takes 1 positional argument but 2 were given"
// for six attempts. An edit that creates a second definition of an existing name is rejected with the
// reason, so the retry edits the existing definition.

const BEFORE_PY = 'from shop.money import format_price\n\n\ndef invoice_line(item):\n    return format_price(item["cents"])\n';
const AFTER_PY = 'from shop.money import format_price\n\ndef invoice_line(item, currency="USD"):\n    return format_price(item["cents"], currency)\n\n\ndef invoice_line(item):\n    return format_price(item["cents"])\n';

describe('newDuplicateDefinitions', () => {
    it('Python: a def added next to an existing def of the same name is reported with both lines', () => {
        const p = newDuplicateDefinitions('shop/invoice.py', BEFORE_PY, AFTER_PY);
        expect(p).toHaveLength(1);
        expect(p[0]).toMatch(/invoice_line is defined twice \(lines 3 and 7\)/);
        expect(p[0]).toMatch(/edit the existing definition/i);
    });

    it('JS/TS: duplicate function and class declarations', () => {
        const before = 'function f(a) { return a; }\n';
        const after = 'function f(a, b) { return a + b; }\nfunction f(a) { return a; }\n';
        expect(newDuplicateDefinitions('src/x.js', before, after)[0]).toMatch(/f is defined twice/);
        expect(newDuplicateDefinitions('src/x.ts', 'class A {}\n', 'class A {}\nclass A {}\n')[0]).toMatch(/A is defined twice/);
    });

    it('a correct edit of the existing definition is fine', () => {
        const after = 'from shop.money import format_price\n\n\ndef invoice_line(item, currency="USD"):\n    return format_price(item["cents"], currency)\n';
        expect(newDuplicateDefinitions('shop/invoice.py', BEFORE_PY, after)).toEqual([]);
    });

    it('only judges duplicates the edit introduced', () => {
        expect(newDuplicateDefinitions('shop/a.py', AFTER_PY, AFTER_PY + '\nx = 1\n')).toEqual([]);
    });

    it('legitimate repeats are not duplicates: overload signatures, property setters, methods in different classes', () => {
        const ts = 'function f(a: string): string;\nfunction f(a: number): number;\nfunction f(a: any) { return a; }\n';
        expect(newDuplicateDefinitions('src/o.ts', '', ts)).toEqual([]);
        const py = 'class A:\n    @property\n    def x(self):\n        return 1\n\n    @x.setter\n    def x(self, v):\n        pass\n\nclass B:\n    def x(self):\n        return 2\n';
        expect(newDuplicateDefinitions('a.py', '', py)).toEqual([]);
    });

    it('unknown file types are not judged', () => {
        expect(newDuplicateDefinitions('notes.md', '', 'def a\ndef a\n')).toEqual([]);
    });
});

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('pipeline: an edit that adds a second definition', () => {
    it('is not applied; the retry is told to edit the existing definition', async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-dup-'));
        await fs.outputFile(path.join(ws, 'shop/invoice.py'), BEFORE_PY);
        const ollama = await import('../src/providers/ollama-local.js');
        vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
        const lp = await import('../src/tools/local-llm-patch.js');
        const instructions: string[] = [];
        const replies = [
            '<<<<<<< SEARCH\nfrom shop.money import format_price\n=======\nfrom shop.money import format_price\n\ndef invoice_line(item, currency="USD"):\n    return format_price(item["cents"], currency)\n>>>>>>> REPLACE',
            '<<<<<<< SEARCH\ndef invoice_line(item):\n    return format_price(item["cents"])\n=======\ndef invoice_line(item, currency="USD"):\n    return format_price(item["cents"], currency)\n>>>>>>> REPLACE',
        ];
        vi.spyOn(lp, 'localLlmPatch').mockImplementation(async (i: any) => {
            instructions.push(i.instruction);
            return { success: true, patch: replies.shift() ?? '' } as any;
        });
        const sessionId = `dup-${Date.now()}`;
        let r: any = await CodingAgentsHandler({ goal: 'give invoice_line a currency parameter', workspaceRoot: ws, targetFiles: ['shop/invoice.py'], dryRun: false, topKFiles: 1, sessionId, review: false } as any);
        for (let i = 0; i < 200 && r.status === 'running'; i++) {
            await new Promise(res => setTimeout(res, 50));
            r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
        }
        expect(instructions[1]).toMatch(/invoice_line is defined twice/);
        const out: string = r.patchPlan[0].fullPatchedContent;
        expect(out.match(/def invoice_line/g)).toHaveLength(1);
        expect(out).toContain('currency="USD"');
    }, 20000);
});
