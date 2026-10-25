import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { apiSurface } from '../src/tools/coding-agents/cross-file.js';
import { CodingAgentsHandler } from '../src/tools/coding-agents.js';

// Traced in the cross-file demo: editing src/cart.js, Qwythos answered "I don't have the current content of
// src/money.js". Each file was edited blind to the others, including the new signature just written into
// money.js. Each file's prompt now carries the other files' API surface, edited ones in their new form.

describe('apiSurface', () => {
    it('keeps declaration and export lines, drops bodies', () => {
        const src = [
            "const { formatPrice } = require('./money');",
            '',
            'class Cart {',
            "  constructor(currency = 'USD') {",
            '    this.items = [];',
            '  }',
            '  summary() {',
            '    return this.items.map(i => i.name).join(",");',
            '  }',
            '}',
            'function helper(a, b) { return a + b; }',
            'export async function load(url: string): Promise<string> {',
            '  return fetch(url);',
            '}',
            'module.exports = { Cart, helper };',
        ].join('\n');
        const s = apiSurface(src);
        expect(s).toContain('class Cart {');
        expect(s).toContain("constructor(currency = 'USD') {");
        expect(s).toContain('summary() {');
        expect(s).toContain('function helper(a, b)');
        expect(s).toContain('export async function load(url: string): Promise<string> {');
        expect(s).toContain('module.exports = { Cart, helper };');
        expect(s).not.toContain('this.items = [];');
        expect(s).not.toContain('return fetch(url);');
    });

    it('is bounded', () => {
        const many = Array.from({ length: 300 }, (_, i) => `export function f${i}() {}`).join('\n');
        expect(apiSurface(many).split('\n').length).toBeLessThanOrEqual(41);
    });
});

let ws = '';
afterEach(async () => { vi.restoreAllMocks(); if (ws) await fs.remove(ws); });

describe('multi-file runs share context', () => {
    it("the second file's prompt shows the first file's NEW signature and says which file to edit", async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-xfile-'));
        await fs.ensureDir(path.join(ws, 'src'));
        await fs.writeFile(path.join(ws, 'src/money.js'), "function formatPrice(cents) {\n  return '$' + cents;\n}\nmodule.exports = { formatPrice };\n");
        await fs.writeFile(path.join(ws, 'src/cart.js'), "const { formatPrice } = require('./money');\nfunction total(c) {\n  return formatPrice(c);\n}\nmodule.exports = { total };\n");
        const ollama = await import('../src/providers/ollama-local.js');
        vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
        const lp = await import('../src/tools/local-llm-patch.js');
        const instructions: string[] = [];
        vi.spyOn(lp, 'localLlmPatch').mockImplementation(async (i: any) => {
            instructions.push(i.instruction);
            const patch = i.filePath.endsWith('money.js')
                ? "<<<<<<< SEARCH\nfunction formatPrice(cents) {\n=======\nfunction formatPrice(cents, currency = 'USD') {\n>>>>>>> REPLACE"
                : "<<<<<<< SEARCH\n  return formatPrice(c);\n=======\n  return formatPrice(c, 'EUR');\n>>>>>>> REPLACE";
            return { success: true, patch } as any;
        });
        const sessionId = `xfile-${Date.now()}`;
        let r: any = await CodingAgentsHandler({ goal: 'add a currency parameter to formatPrice and pass EUR from cart', workspaceRoot: ws, targetFiles: ['src/money.js', 'src/cart.js'], dryRun: false, topKFiles: 2, sessionId, review: false } as any);
        for (let i = 0; i < 200 && r.status === 'running'; i++) {
            await new Promise(res => setTimeout(res, 50));
            r = await CodingAgentsHandler({ goal: 'x', sessionId, action: 'status' });
        }
        expect(instructions.length).toBeGreaterThanOrEqual(2);
        const cartPrompt = instructions.find(t => /edit only src\/cart\.js/i.test(t));
        expect(cartPrompt).toBeDefined();
        expect(cartPrompt).toContain("function formatPrice(cents, currency = 'USD') {");
        expect(cartPrompt).toMatch(/already edited/i);
        const moneyPrompt = instructions.find(t => /edit only src\/money\.js/i.test(t));
        expect(moneyPrompt).toContain('function total(c) {');
    }, 20000);
});
