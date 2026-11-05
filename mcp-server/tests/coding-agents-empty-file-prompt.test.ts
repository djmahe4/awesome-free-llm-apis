import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { generateFilePatch } from '../src/tools/coding-agents/generate-file-patch.js';
import { deriveHypotheses } from '../src/tools/coding-agents/hypothesis-gate.js';
import { formatCodingAgentsMarkdown } from '../src/tools/coding-agents/types.js';
import type { CodingAgentsInput, CodingAgentsResult } from '../src/tools/coding-agents/types.js';

describe('empty file generation in coding_agents', () => {
    let ws = '';
    const calls: Array<{ format?: string; instruction?: string; contentOverride?: string }> = [];

    beforeEach(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-empty-'));
        calls.length = 0;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        if (ws) await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it('skips SEARCH/REPLACE and uses full-file generation directly for empty files', async () => {
        const lp = await import('../src/tools/local-llm-patch.js');
        vi.spyOn(lp, 'localLlmPatch').mockImplementation(async (i: any) => {
            calls.push({ format: i.outputFormat, instruction: i.instruction, contentOverride: i.contentOverride });
            return {
                success: true,
                patch: 'def generate_http_token_pcap(payload: str) -> bytes:\n    return b"test"\n',
            } as any;
        });

        const fullPath = path.join(ws, 'pcap_http_token.py');
        await fs.writeFile(fullPath, ''); // 0-byte file

        const result = {
            sessionId: 's1',
            goal: 'In pcap_http_token.py, implement generate_http_token_pcap',
            pipelineStage: 'edit',
            relevantFiles: ['pcap_http_token.py'],
            anchors: [],
            patchPlan: [],
            patchSummary: '',
            diagnostics: [],
            applied: false,
        } as unknown as CodingAgentsResult;

        const ctx = {
            input: { goal: 'In pcap_http_token.py, implement generate_http_token_pcap' } as CodingAgentsInput,
            result,
            relPath: 'pcap_http_token.py',
            fullPath,
            workspaceRoot: ws,
            sessionId: 's1',
            resolvedModel: 'qwen2.5-coder:7b',
            originalContent: '', // empty!
            activeGoal: 'In pcap_http_token.py, implement generate_http_token_pcap',
            changeFiles: ['pcap_http_token.py'],
            runContents: new Map<string, string>(),
            editedInRun: new Set<string>(),
        };

        const out = await generateFilePatch(ctx);

        expect(out.failed).toBe(false);
        expect(out.patchedContent).toContain('def generate_http_token_pcap');
        // CRITICAL: Must not have attempted SEARCH/REPLACE format on an empty file
        expect(calls.some(c => c.format === 'search-replace')).toBe(false);
        // CRITICAL: Instruction to model warns not to paste the goal text as code
        expect(calls[0].instruction).toMatch(/empty|scratch|do not paste/i);
    });
});

describe('hypothesis gate with stdlib, methods and external symbols', () => {
    it('does not refute Python stdlib, common methods or third-party packet types as missing workspace symbols', () => {
        const goal = 'In pcap_http_token.py, implement `generate_http_token_pcap`. Use scapy `Ether`, `IP`, `TCP`. Write to `BytesIO`, call `flush()`, `getvalue()`, and `encode()` the payload.';
        const hypotheses = deriveHypotheses({
            goal,
            files: ['pcap_http_token.py'],
        });

        const probes = hypotheses.map(h => h.probe);
        // generate_http_token_pcap is the function to create/implement: asksToCreate catches it
        expect(probes).not.toContain('defined:generate_http_token_pcap');
        // Stdlib, methods, third-party libraries should NOT be treated as required workspace definitions
        expect(probes).not.toContain('defined:BytesIO');
        expect(probes).not.toContain('defined:encode');
        expect(probes).not.toContain('defined:flush');
        expect(probes).not.toContain('defined:getvalue');
        expect(probes).not.toContain('defined:Ether');
    });
});

describe('markdown status for proposed plan', () => {
    it('displays Proposed Plan (Pending Apply) rather than Dry Run when status is proposed', () => {
        const result: CodingAgentsResult = {
            sessionId: 'test-sess',
            goal: 'implement token pcap',
            pipelineStage: 'completed',
            relevantFiles: ['pcap_http_token.py'],
            anchors: [],
            patchPlan: [{ filePath: 'pcap_http_token.py', unifiedDiff: '@@ -1 +1 @@', fullPatchedContent: 'code' }],
            patchSummary: 'diff',
            diagnostics: [],
            applied: false,
            status: 'proposed',
        };

        const md = formatCodingAgentsMarkdown(result);
        expect(md).toContain('Proposed Plan (Pending Apply)');
        expect(md).not.toContain('Proposed Plan (Dry Run)');
    });
});


describe('resolving a proposed plan', () => {
    it('applies the cached proposed plan on follow-up resolve: { action: "apply" } without requiring goal', async () => {
        const { CodingAgentsHandler } = await import('../src/tools/coding-agents.js');
        const resolveWs = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-resolve-'));
        try {
            await fs.outputFile(path.join(resolveWs, 'src/a.ts'), 'export const a = 1;\n');
            const ollama = await import('../src/providers/ollama-local.js');
            vi.spyOn(ollama, 'listLocalModels').mockResolvedValue(['qwen2.5-coder:7b']);
            const lp = await import('../src/tools/local-llm-patch.js');
            vi.spyOn(lp, 'localLlmPatch').mockResolvedValue({
                success: true,
                patch: '<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE',
            } as any);

            const sessionId = `resolve-test-${Date.now()}`;
            // 1. First call: dryRun: false proposes
            let r: any = await CodingAgentsHandler({
                goal: 'change a to 2',
                workspaceRoot: resolveWs,
                targetFiles: ['src/a.ts'],
                dryRun: false,
                sessionId,
                review: false,
            });
            for (const t0 = Date.now(); r.status === 'running' && Date.now() - t0 < 60_000;) {
                await new Promise(res => setTimeout(res, 50));
                r = await CodingAgentsHandler({ sessionId, action: 'status' });
            }
            expect(r.status).toBe('proposed');
            expect(r.applied).toBe(false);

            // File on disk is still unchanged
            expect(await fs.readFile(path.join(resolveWs, 'src/a.ts'), 'utf-8')).toBe('export const a = 1;\n');

            // 2. Follow-up call: resolve: { action: 'apply' } with goal (satisfying schema) and WITHOUT dryRun: false
            const appliedRes: any = await CodingAgentsHandler({
                goal: 'change a to 2',
                sessionId,
                workspaceRoot: resolveWs,
                resolve: { action: 'apply' },
            });

            expect(appliedRes.applied).toBe(true);
            expect(appliedRes.status).toBe('applied');
            // File on disk is now updated!
            expect(await fs.readFile(path.join(resolveWs, 'src/a.ts'), 'utf-8')).toBe('export const a = 2;\n');
        } finally {
            await fs.rm(resolveWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
