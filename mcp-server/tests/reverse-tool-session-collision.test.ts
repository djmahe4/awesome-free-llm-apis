import { describe, it, expect, afterAll } from 'vitest';
import { runReverseTool } from '../src/tools/reverse-tool.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// The run key came from the target alone, so a second, different action on the same model, sent while the first was
// still running, was answered "already in progress" (the dashboard hit this with infer_layer_roles, then
// analyze_model_layer and trace_layer_execution). A run is now keyed by target and action unless the caller names a session.

const fixture = path.resolve(__dirname, 'fixtures/models/tiny.gguf');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const copyOf = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-collide-'));
    dirs.push(dir);
    const p = path.join(dir, `tiny-${Date.now()}-${Math.floor(Math.random() * 1e6)}.gguf`);
    fs.copyFileSync(fixture, p);
    return p;
};

describe('reverse_tool runs on one model', () => {
    it('a different action is not blocked by a run in progress', async () => {
        const target = copyOf();
        const first = await runReverseTool({ action: 'inspect_model', target, authorization: 'lab', options: { async: true } });
        expect(first.success).toBe(true);
        const second = await runReverseTool({ action: 'analyze_model_layer', target, authorization: 'lab', options: { layer: 'blk.0.attn_q.weight' } });
        expect(second.success).toBe(true);
        expect((second.data as any).status).not.toBe('running');
        expect((second.data as any).elementCount).toBe(16);
    });

    it('the same action twice at once is still one run', async () => {
        const target = copyOf();
        await runReverseTool({ action: 'inspect_model', target, authorization: 'lab', options: { async: true } });
        const dup = await runReverseTool({ action: 'inspect_model', target, authorization: 'lab', options: { async: true } });
        expect((dup.data as any).status).toBe('running');
        expect((dup.data as any).message).toContain('already in progress');
    });

    it('status with only the target finds the run that was started', async () => {
        const target = copyOf();
        const started = await runReverseTool({ action: 'inspect_model', target, authorization: 'lab', options: { async: true } });
        const sessionId = (started.data as any).sessionId;
        expect(typeof sessionId).toBe('string');
        const status = await runReverseTool({ action: 'status', target });
        expect((status.data as any).sessionId).toBe(sessionId);
        expect(['running', 'done']).toContain((status.data as any).status ?? 'done');
    });

    it('a named session is used as given', async () => {
        const target = copyOf();
        const sessionId = `named-${Date.now()}`;
        const run = await runReverseTool({ action: 'inspect_model', target, authorization: 'lab', sessionId, options: { async: true } });
        expect((run.data as any).sessionId).toBe(sessionId);
    });
});
