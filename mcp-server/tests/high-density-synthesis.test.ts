import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { getIntelligentSystemPrompt, resetPromptCache } from '../src/middleware/agentic/prompts.js';

vi.mock('fs', () => {
    const mockPromises = {
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        access: vi.fn(),
        readFile: vi.fn(),
        stat: vi.fn(),
    };
    return {
        default: {
            promises: mockPromises,
        },
        promises: mockPromises,
    };
});

describe('High-Density Synthesis for Multi-Agent Workflows', () => {
    const PROMPT_CHAR_BUDGET = 12000;

    const mockDenseData = {
        metadata: { version: '1.2.0' },
        introduction: "Principal Architect Core\n",
        sections: [
            {
                id: "sec_arch",
                title: "ARCHITECTURE PRINCIPLES",
                content: "Layered complexity and modular design guidelines.".padEnd(2000, '.'),
                level: 1,
                keywords: ["arch", "architecture", "modular", "design"]
            },
            {
                id: "sec_security",
                title: "SECURITY PROTOCOLS",
                content: "Threat modeling, credential isolation, and audit trails.".padEnd(2000, '.'),
                level: 1,
                keywords: ["security", "auth", "audit", "isolation"]
            },
            {
                id: "sec_performance",
                title: "PERFORMANCE OPTIMIZATION",
                content: "Event-loop guarding and non-blocking I/O patterns.".padEnd(2000, '.'),
                level: 2,
                keywords: ["performance", "async", "latency", "optimization"]
            },
            {
                id: "sec_api",
                title: "API STANDARDS",
                content: "RESTful principles and JSON-RPC compliance.".padEnd(2000, '.'),
                level: 2,
                keywords: ["api", "rest", "json", "rpc"]
            },
            {
                id: "subsystem_reference_map",
                title: "SUBSYSTEM REFERENCE MAP",
                content: `
- [Auth Subsystem](https://auth.internal/docs)
  Handles JWT and session tokens.
- [Payment Gateway](https://stripe.com/docs)
  Stripe integration hooks.
- [Redis Cache](https://redis.io/docs)
  Distributed caching for state.
- [Database Service](https://postgres.org/docs)
  Relational schema management.
- [Worker Queue](https://temporal.io/docs)
  Durable execution for background tasks.
`.trim(),
                level: 2,
                keywords: ["reference", "docs", "external", "link"]
            }
        ]
    };

    beforeEach(() => {
        vi.clearAllMocks();
        resetPromptCache();

        const fsp = fs.promises;
        (fsp.stat as any).mockResolvedValue({ mtimeMs: 12345 });
        (fsp.readFile as any).mockResolvedValue(JSON.stringify(mockDenseData));
    });

    it('should prioritize sections based on combinatorial keyword matching', async () => {
        // High-density keywords matching multiple sections
        const keywords = ["arch", "security", "performance"];
        const prompt = await getIntelligentSystemPrompt("Building a secure modular system with low latency", keywords);

        expect(prompt).toContain("ARCHITECTURE PRINCIPLES");
        expect(prompt).toContain("SECURITY PROTOCOLS");
        expect(prompt).toContain("PERFORMANCE OPTIMIZATION");
        expect(prompt).not.toContain("API STANDARDS"); // Lower priority since 'api' not in keywords
    });

    it('should enforce the 12k budget while keeping high-level sections', async () => {
        // All 4 sections (2k each) + Reference Map + Intro might fit, 
        // but let's see how close it gets.
        const keywords = ["arch", "security", "performance", "api", "reference"];
        const prompt = await getIntelligentSystemPrompt("Complex multi-agent task", keywords);

        expect(prompt.length).toBeLessThanOrEqual(PROMPT_CHAR_BUDGET + 500); // 12k budget + small buffer for protocol/intro
        
        // Ensure level 1 sections are definitely there
        expect(prompt).toContain("ARCHITECTURE PRINCIPLES");
        expect(prompt).toContain("SECURITY PROTOCOLS");
    });

    it('should fragment reference maps to only relevant entries across agents', async () => {
        // This simulates a 'Payment Agent' turn
        const prompt = await getIntelligentSystemPrompt("Implementing the payment gateway hooks", ["reference", "payment"]);

        expect(prompt).toContain("SUBSYSTEM REFERENCE MAP");
        expect(prompt).toContain("Payment Gateway");
        expect(prompt).toContain("https://stripe.com/docs");

        // Should NOT contain irrelevant links to save density budget
        expect(prompt).not.toContain("Redis Cache");
        expect(prompt).not.toContain("Database Service");
    });

    it('should prioritize WORKSPACE MEMORY regardless of density', async () => {
        const memoryContext = "- Memory Entry A: Past decision on performance\n- Memory Entry B: Past auth bug fix";
        const prompt = await getIntelligentSystemPrompt("Optimizing the system", ["performance"], memoryContext);

        expect(prompt).toContain("WORKSPACE MEMORY");
        expect(prompt).toContain("Memory Entry A");
        expect(prompt).toContain("Memory Entry B");
        
        // Verify it's near the top (after introduction)
        const posMemory = prompt.indexOf("WORKSPACE MEMORY");
        const posSection = prompt.indexOf("PERFORMANCE OPTIMIZATION");
        expect(posMemory).toBeLessThan(posSection);
    });

    it('should switch between Strict and Fuzzy steering combinations', async () => {
        // Fuzzy steering (context only)
        const fuzzyPrompt = await getIntelligentSystemPrompt("How do I build an api?");
        expect(fuzzyPrompt).toContain("API STANDARDS");

        // Strict steering (keywords provided - should ignore 'api' in context if not in keywords)
        const strictPrompt = await getIntelligentSystemPrompt("How do I build an api?", ["security"]);
        expect(strictPrompt).toContain("SECURITY PROTOCOLS");
        expect(strictPrompt).not.toContain("API STANDARDS");
    });

    it('should handle multi-turn subtask synthesis correctly', async () => {
        // Simulate a planner turn where "auth" is identified
        const turn1Keywords = ["arch", "auth"];
        const prompt1 = await getIntelligentSystemPrompt("Implement login system", turn1Keywords);
        expect(prompt1).toContain("ARCHITECTURE PRINCIPLES");
        expect(prompt1).toContain("SECURITY PROTOCOLS");

        // Simulate a follow-up coder turn where "performance" is now the focus
        const turn2Keywords = ["security", "performance"];
        const prompt2 = await getIntelligentSystemPrompt("Fix performance of login hashing", turn2Keywords);
        expect(prompt2).toContain("SECURITY PROTOCOLS");
        expect(prompt2).toContain("PERFORMANCE OPTIMIZATION");
        expect(prompt2).not.toContain("ARCHITECTURE PRINCIPLES"); // Should be swapped out if budget/priority shifts
    });
});
