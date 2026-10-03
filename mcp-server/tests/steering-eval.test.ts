import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createExpressApp } from '../src/server.js';
import { WorkspaceContextMiddleware } from '../src/pipeline/middlewares/WorkspaceContextMiddleware.js';
import { getIntelligentSystemPrompt, evaluatePromptSections } from '../src/pipeline/middlewares/prompts.js';

async function callSteeringEval(body: unknown): Promise<{ status: number; body: any }> {
    const app = createExpressApp();
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/steering_eval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

describe('Steering Evaluation & Ingestion Inspector API (/api/steering_eval)', () => {
    it('evaluatePromptSections returns matched prompt sections with content and token metadata', async () => {
        const result = await evaluatePromptSections({
            context: 'Fix bug in auth middleware and security rate limit',
            keywords: ['security', 'auth', 'rate-limit']
        });

        expect(result).toBeDefined();
        expect(typeof result.prompt).toBe('string');
        expect(result.prompt.length).toBeGreaterThan(50);
        expect(Array.isArray(result.matchedSections)).toBe(true);
        expect(result.matchedSections.length).toBeGreaterThan(0);
        expect(result.totalPromptTokens).toBeGreaterThan(0);
        // Expect section content to be populated for full inspection
        expect(result.matchedSections[0].content).toBeDefined();
        expect(typeof result.matchedSections[0].content).toBe('string');
    });

    it('WorkspaceContextMiddleware attaches comprehensive steeringTelemetry to context', async () => {
        const middleware = new WorkspaceContextMiddleware();
        const context: any = {
            request: {
                model: 'gemini-3.1-flash-lite',
                agentic: true,
                messages: [
                    { role: 'user', content: 'Fix bug in auth middleware and check security rate limiting' }
                ]
            },
            taskType: 'coder',
            keywords: ['security', 'auth', 'rate-limit'],
            workspaceRoot: process.cwd(),
            sessionId: 'test-steering-session',
            isOnePass: false,
            subtask: { id: 'subtask-1', title: 'Audit authentication logic' }
        };

        await middleware.execute(context, async () => {});

        expect(context.telemetry).toBeDefined();
        expect(context.telemetry.steeringTelemetry).toBeDefined();

        const st = context.telemetry.steeringTelemetry;
        expect(st.persona).toBe('coder');
        expect(st.matchedKeywords).toContain('security');
        expect(st.memoryLayers).toBeDefined();
        expect(st.memoryLayers.shortTermTokens).toBeDefined();
        expect(st.memoryLayers.longTermTokens).toBeDefined();
        expect(st.memoryLayers.wikiTokens).toBeDefined();
        expect(st.memoryLayers.grepTokens).toBeDefined();
        expect(st.fullAssembledSystemPrompt).toBeDefined();
        expect(st.subtaskContext).toBeDefined();
        expect(st.subtaskContext.title).toBe('Audit authentication logic');
    });

    it('WorkspaceContextMiddleware does not double-count non-agentic injected-prompt layers', async () => {
        const middleware = new WorkspaceContextMiddleware();
        const context: any = {
            request: {
                model: 'gemini-3.1-flash-lite',
                agentic: false,
                messages: [
                    { role: 'user', content: 'Fix bug in auth middleware and check security rate limiting' }
                ]
            },
            taskType: 'coder',
            keywords: ['security', 'auth', 'rate-limit'],
            workspaceRoot: process.cwd(),
            sessionId: 'test-steering-nonagentic',
            isOnePass: true
        };

        await middleware.execute(context, async () => {});

        const st = context.telemetry.steeringTelemetry;
        expect(st.memoryLayers.sysPromptTokens).toBeGreaterThan(0);
        // The non-agentic system prompt embeds memory + wiki + grep + grounding gate,
        // so total must be messages + injected prompt — not the sum of every layer.
        expect(st.memoryLayers.totalContextTokens).toBe(
            (st.memoryLayers.shortTermTokens || 0) + st.memoryLayers.sysPromptTokens
        );
    });
});

describe('/api/steering_eval token accounting (endpoint)', () => {
    const AGENTIC_QUERY = 'Fix bug in auth middleware and check security rate limiting';

    it('non-agentic total = shortTerm + sysPromptTokens (no double-count)', async () => {
        const { status, body: res } = await callSteeringEval({
            query: AGENTIC_QUERY,
            keywords: ['security', 'auth', 'rate-limit'],
            workspaceRoot: process.cwd()
        });

        expect(status).toBe(200);
        expect(res.success).toBe(true);
        const mem = res.telemetry.memoryLayers;
        expect(mem.sysPromptTokens).toBeGreaterThan(0);
        expect(mem.totalContextTokens).toBe(
            (mem.shortTermTokens || 0) + mem.sysPromptTokens
        );
    });

    it('agentic total = shortTerm + sysPromptTokens + groundingTokens', async () => {
        const { status, body: res } = await callSteeringEval({
            query: AGENTIC_QUERY,
            agentic: true,
            workspaceRoot: process.cwd()
        });

        expect(status).toBe(200);
        expect(res.success).toBe(true);
        const mem = res.telemetry.memoryLayers;
        expect(mem.sysPromptTokens).toBeGreaterThan(0);
        // Server-built subtask prompt embeds memory + wiki + grep; the grounding
        // gate is added separately by AgenticMiddleware to the first prompt.
        expect(mem.totalContextTokens).toBe(
            (mem.shortTermTokens || 0) + mem.sysPromptTokens + (mem.groundingTokens || 0)
        );
        expect(res.telemetry.comparison).toBeDefined();
    });

    it('explicit no-workspace one-shot evaluates clean (no prompt, no AGENTS, no auto keywords)', async () => {
        const { status, body: res } = await callSteeringEval({
            query: 'say hello',
            keywords: [],
            workspaceRoot: ''
        });

        expect(status).toBe(200);
        expect(res.success).toBe(true);
        const st = res.telemetry;
        const mem = st.memoryLayers;
        expect(mem.sysPromptTokens).toBe(0);
        expect(mem.totalContextTokens).toBe(mem.shortTermTokens || 0);
        expect(st.fullAssembledSystemPrompt).toBe('');
        expect(st.matchedSections).toHaveLength(0);
        expect(st.keywords).toEqual([]);
        const l5 = st.memoryHierarchy.find((l: any) => l.level === 'L5');
        expect(l5.active).toBe(false);
    });

    it('agentic with explicit empty workspaceRoot builds no plan (no server-cwd fallback)', async () => {
        const { status, body: res } = await callSteeringEval({
            query: AGENTIC_QUERY,
            agentic: true,
            workspaceRoot: ''
        });

        expect(status).toBe(200);
        expect(res.success).toBe(true);
        expect(res.telemetry.planDetails).toBeNull();
        expect(res.telemetry.keywords).toEqual([]);
    });

    it('returns a measured comparison payload for the savings card', async () => {
        const { status, body: res } = await callSteeringEval({
            query: AGENTIC_QUERY,
            keywords: ['security', 'auth', 'rate-limit'],
            workspaceRoot: process.cwd()
        });

        expect(status).toBe(200);
        const cmp = res.telemetry.comparison;
        expect(cmp).toBeDefined();
        expect(cmp.singlePassPayloadTokens).toBeGreaterThan(0);
        // Non-agentic: the current payload IS the measured total.
        expect(cmp.singlePassPayloadTokens).toBe(res.telemetry.memoryLayers.totalContextTokens);
        expect(cmp.agenticSubtaskCount).toBeGreaterThanOrEqual(1);
        expect(cmp.agenticFirstSubtaskTokens).toBeGreaterThan(0);
        expect(cmp.agenticRunTokens).toBeGreaterThanOrEqual(cmp.agenticFirstSubtaskTokens);
    });
});
