import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

// Issue #111: with CODING_AGENTS_TRACE_DIR set, local model replies were saved but the cloud ones were not, so when the
// repair loop handed an edit to the cloud model there was no way to see what it wrote or why it was rejected.

const model = vi.hoisted(() => ({ reply: vi.fn(async (_req: unknown): Promise<string> => '') }));
vi.mock('../src/tools/use-free-llm.js', () => ({
    useFreeLLM: async (req: unknown) => ({ choices: [{ message: { content: await model.reply(req) } }] }),
}));

const ORIGINAL = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
const SEARCH_REPLACE = '<<<<<<< SEARCH\n  return a + b;\n=======\n  return a + b + 0;\n>>>>>>> REPLACE';

let ws = '';
let traceDir = '';
beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-trace-ws-'));
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-trace-out-'));
    fs.writeFileSync(path.join(ws, 'a.ts'), ORIGINAL);
});
afterAll(() => {
    for (const d of [ws, traceDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    delete process.env.CODING_AGENTS_TRACE_DIR;
});
beforeEach(() => {
    process.env.CODING_AGENTS_TRACE_DIR = traceDir;
    for (const f of fs.readdirSync(traceDir)) fs.rmSync(path.join(traceDir, f), { force: true });
});

function context(input: Partial<CodingAgentsInput> = {}) {
    const result = { sessionId: 's', goal: 'g', pipelineStage: 'locate', relevantFiles: [], anchors: [], patchPlan: [], patchSummary: '', diagnostics: [], applied: false } as unknown as CodingAgentsResult;
    return {
        input: { goal: 'add zero to the sum', allowCloudFallback: true, ...input } as CodingAgentsInput,
        result, relPath: 'a.ts', fullPath: path.join(ws, 'a.ts'), workspaceRoot: ws, sessionId: 's',
        resolvedModel: null, originalContent: ORIGINAL, activeGoal: 'add zero to the sum',
        changeFiles: ['a.ts'], runContents: new Map<string, string>(), editedInRun: new Set<string>(),
    };
}
const dumps = () => fs.readdirSync(traceDir).map(f => ({ name: f, text: fs.readFileSync(path.join(traceDir, f), 'utf-8') }));

describe('cloud replies are saved to the trace directory', () => {
    it('the cloud SEARCH/REPLACE reply is saved, labelled as cloud', async () => {
        model.reply.mockResolvedValue(SEARCH_REPLACE);
        const out = await generateFilePatch(context());
        expect(out.patchedContent).toContain('a + b + 0');
        const saved = dumps().find(d => /cloud/i.test(d.name) && /sr|search/i.test(d.name));
        expect(saved?.text).toContain('<<<<<<< SEARCH');
    });

    it('the cloud full-file reply is saved too, even when it is then rejected', async () => {
        // no usable blocks: the pipeline falls through to the full-file cloud path
        model.reply.mockImplementation(async () => 'Sure, here is the file:\nexport function add() { return 42; }\n');
        await generateFilePatch(context());
        const saved = dumps().filter(d => /cloud/i.test(d.name));
        expect(saved.some(d => d.text.includes('return 42'))).toBe(true);
    });

    it('nothing is written when CODING_AGENTS_TRACE_DIR is not set', async () => {
        delete process.env.CODING_AGENTS_TRACE_DIR;
        model.reply.mockResolvedValue(SEARCH_REPLACE);
        await generateFilePatch(context());
        expect(dumps()).toEqual([]);
    });
});

// Issue #131: the loop raises the temperature on every retry so a retry is not a repeat, but the cloud call did not pass
// it on, so identical retry prompts were answered from the response cache.
describe('the cloud call carries the attempt\'s temperature', () => {
    const lastRequest = () => model.reply.mock.calls.at(-1)![0] as { temperature?: number };

    it('sends the temperature of the attempt', async () => {
        model.reply.mockClear();
        model.reply.mockResolvedValue(SEARCH_REPLACE);
        await generateFilePatch(context({ temperature: 0.4 }));
        expect(lastRequest().temperature).toBe(0.4);
    });
    it('sends none when the attempt has none', async () => {
        model.reply.mockClear();
        model.reply.mockResolvedValue(SEARCH_REPLACE);
        await generateFilePatch(context());
        expect(lastRequest().temperature).toBeUndefined();
    });
});
