import { TaskType } from '../../src/pipeline/middleware.js';
import { WorkspaceContextMiddleware } from '../../src/pipeline/middlewares/WorkspaceContextMiddleware.js';

/**
 * 🤖 AGENTIC MECHANISM SIMULATION v3 (LIVE Grounded)
 * 
 * Demonstrates:
 * 1. Planning (Decomposition)
 * 2. LIVE Grounding (Actual WorkspaceContextMiddleware invocation)
 * 3. Distribution (Specialist Routing)
 */

async function runSimulation() {
    console.log('--- 🚀 LIVE AGENTIC MECHANISM SIMULATION START ---\n');

    const highLevelGoal = "Implement a circuit breaker for the LLM executor.";
    const workspaceRoot = process.cwd(); // Run from mcp-server root
    console.log(`[USER GOAL]: "${highLevelGoal}"`);
    console.log(`[WORKSPACE]: ${workspaceRoot}\n`);

    const wsMw = new WorkspaceContextMiddleware();

    // --- PHASE 1: PLANNING ---
    const subtasks = [
        "1. Research circuit breaker patterns.",
        "2. Modify src/utils/LLMExecutor.ts.",
        "3. Write unit tests for ContextManager."
    ];
    console.log('--- PHASE 1: PLANNING (Decomposition) ---');
    subtasks.forEach(task => console.log(`  ${task}`));
    console.log('');

    // --- PHASE 2: LIVE GROUNDING & DISTRIBUTION ---
    console.log('--- PHASE 2: LIVE GROUNDING & DISTRIBUTION ---');
    
    for (const task of subtasks) {
        console.log(`\n[SUBTASK]: ${task}`);

        // Extract naïve keywords for simulation purposes
        const words = task.replace(/[^\w\s]/g, '').split(/\s+/);
        const keywords = words.filter(w => w.length >= 4);

        // Construct mock PipelineContext
        const ctx = {
            sessionId: 'live-sim-123',
            workspaceRoot,
            request: {
                messages: [{ role: 'user', content: task }],
                agentic: true,
            },
            keywords: keywords
        } as any;

        // 1. LIVE GROUNDING
        console.log(`  ↳ Running Live WorkspaceContextMiddleware (Keywords: ${keywords.join(', ')}) ...`);
        await wsMw.execute(ctx, async () => {});

        const memCtx = ctx.memoryContext ? ctx.memoryContext.length + " chars" : "None";
        const codeCtx = ctx.grepContext ? ctx.grepContext.length + " chars" : "None";

        console.log(`  ↳ 🧠 Live Vector Memory Found: ${memCtx}`);
        if (ctx.memoryContext) {
             console.log(`       Preview: "${ctx.memoryContext.slice(0, 100).replace(/\n/g, ' ')}..."`);
        }

        console.log(`  ↳ 📂 Live Code Context Found: ${codeCtx}`);
        if (ctx.grepContext) {
             console.log(`       Preview: "${ctx.grepContext.slice(0, 100).replace(/\n/g, ' ')}..."`);
        }

        // 2. DISTRIBUTION (ROUTING)
        let taskType = TaskType.Chat;
        if (task.includes('Research')) taskType = TaskType.SemanticSearch;
        if (task.includes('Modify')) taskType = TaskType.Coding;
        if (task.includes('Write')) taskType = TaskType.Reasoning;

        let targetModel = "default";
        if (taskType === TaskType.SemanticSearch) targetModel = "Gemini 2.0 Flash (Search Specialist)";
        if (taskType === TaskType.Coding) targetModel = "DeepSeek-V3 (Coding Specialist)";
        if (taskType === TaskType.Reasoning) targetModel = "DeepSeek-R1 (Reasoning Specialist)";

        console.log(`  ↳ Classification: ${taskType.toUpperCase()}`);
        console.log(`  ↳ ROUTED TO: ${targetModel}`);
        console.log('  ----------------------------------------');
    }

    console.log('\n--- ✅ SIMULATION COMPLETE ---');
}

runSimulation().catch(console.error);
