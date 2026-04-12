import { 
    PipelineExecutor, 
    IntelligentRouterMiddleware, 
    AgenticMiddleware, 
    TaskType, 
    PipelineContext 
} from '../src/pipeline/index.js';
import { StructuralMarkdownMiddleware } from '../src/middleware/agentic/structural-middleware.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';
import path from 'node:path';

async function runTask(name: string, prompt: string, options: any = {}) {
    console.log(`\n🚀 RUNNING TASK: ${name}`);
    console.log(`📝 PROMPT: "${prompt}"`);

    const executor = new LLMExecutor();
    const pipeline = new PipelineExecutor();
    
    // Build the full production pipeline (minus cache)
    pipeline.use(new StructuralMarkdownMiddleware());
    pipeline.use(new AgenticMiddleware());
    pipeline.use(new IntelligentRouterMiddleware(executor));

    const context: PipelineContext = {
        request: {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: options.agentic ? 12000 : 8000, // Agentic reasoning needs more tokens
            agentic: options.agentic
        },
        workspaceRoot: options.workspaceRoot,
        agentic: options.agentic,
        sessionId: options.sessionId || `demo-${Date.now()}`
    };

    const startTime = Date.now();
    try {
        // Execute through the full pipeline
        await pipeline.execute(context);

        const duration = Date.now() - startTime;

        console.log(`✅ COMPLETED in ${duration}ms`);
        console.log(`🤖 MODEL: ${context.response?.model || 'Unknown'}`);
        console.log(`📊 TASK TYPE: ${context.taskType || 'N/A'}`);
        
        const content = context.response?.choices[0]?.message?.content || '';
        console.log(`\n🤖 RESPONSE PREVIEW (First 1000 chars):`);
        console.log(`--------------------------------------------------`);
        console.log(content.length > 1000 ? content.substring(0, 1000) + '...' : content);
        console.log(`--------------------------------------------------`);

        // Verification for Grounding Protocol
        if (options.agentic) {
            const hasAttestation = content.includes('[RETRIEVED]') || content.includes('[NOT FOUND]');
            console.log(`🔍 Grounding Attestation Present: ${hasAttestation ? '✅ YES' : '❌ NO'}`);
            if (hasAttestation) {
                const count = (content.match(/\[RETRIEVED\]|\[NOT FOUND\]/g) || []).length;
                console.log(`   (Found ${count} attestation tags)`);
            }
        }

    } catch (err: any) {
        console.error(`❌ FAILED: ${err.message}`);
        if (err.stack) console.debug(err.stack);
    }
    console.log(`\n==================================================`);
}

const tasks = [
    {
        name: "Hedged Execution Test (Reasoning)",
        prompt: "Explain the architectural advantages of a hedged execution strategy in a multi-provider LLM router. Why is it better than a simple fallback list? Use a deep reasoning model. (Expect hedge launch after ~20s)",
        options: { agentic: false }
    },
    {
        name: "Agentic Grounding & README Gate Test",
        prompt: "Analyze the current project's IntelligentRouter architecture. Based ONLY on the files you can see via the workspace context, suggest a plan to improve its error handling for 429 errors. You MUST attest to what you find.",
        options: {
            agentic: true,
            workspaceRoot: process.cwd()
        }
    },
    {
        name: "Grounding Attestation Test (Forced Context)",
        prompt: "I have retrieved the content of `src/pipeline/middleware.ts`. It contains an interface `PipelineContext` with a field `taskType?: TaskType`. Confirm if this matches your understanding. You MUST use the grounding protocol tags.",
        options: {
            agentic: true,
            workspaceRoot: process.cwd(),
            sessionId: "test-attestation-" + Date.now()
        }
    },
    {
        name: "Entity/JSON Extraction (Fast)",
        prompt: "Convert this list into a strictly valid JSON array of objects with keys 'api_name', 'tier', 'status': 'The Gemini Pro API offers a free tier for testing, whereas OpenAI GPT-4o is paid. QuantPi-X2 is currently in closed beta.'",
        options: { agentic: false }
    }
];

async function start() {
    console.log("\n🌟 STARTING FREE-LLMS INTELLIGENT ROUTER LIVE DEMO 🌟");
    console.log("==================================================");
    console.log("FEATURES ON DISPLAY:");
    console.log("1. Hedged Execution: Automatically parallelizes slow requests.");
    console.log("2. Grounding Gate: Forces 'Read-First' behavior via README sensing.");
    console.log("3. AST Extraction: Structural session memory instead of raw dumps.");
    console.log("4. Attestation Protocol: Models must prefix facts with [RETRIEVED].");
    console.log("==================================================\n");

    for (const task of tasks) {
        await runTask(task.name, task.prompt, task.options);
    }
}

start().catch(err => {
    console.error("FATAL ERROR:", err);
    process.exit(1);
});
