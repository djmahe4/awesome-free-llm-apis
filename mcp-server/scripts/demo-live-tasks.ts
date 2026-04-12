import { IntelligentRouterMiddleware, TaskType, PipelineContext } from '../src/pipeline/index.js';
import { LLMExecutor } from '../src/utils/LLMExecutor.js';

const executor = new LLMExecutor();
const router = new IntelligentRouterMiddleware(executor);

async function runTask(name: string, prompt: string) {
    console.log(`\n🚀 RUNNING TASK: ${name}`);
    console.log(`📝 PROMPT: "${prompt}"`);

    const context: PipelineContext = {
        request: {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8000 // Required for DeepSeek-R1's deep reasoning `<think>` blocks
        }
    };

    const startTime = Date.now();
    try {
        // Execute through the middleware
        await router.execute(context, async () => {
            // This is the "next" handler
        });

        const duration = Date.now() - startTime;

        console.log(`✅ COMPLETED in ${duration}ms`);
        console.log(`🤖 MODEL: ${context.response?.model || 'Unknown'}`);
        console.log(`📊 TASK TYPE: ${context.taskType}`);
        console.log(`📝 PREVIEW: ${context.response?.choices[0]?.message?.content}`);
    } catch (err: any) {
        console.error(`❌ FAILED: ${err.message}`);
    }
    console.log(`\n--------------------------------------------------`);
}

const tasks = [
    {
        name: "Hedged Execution Test (Reasoning)",
        prompt: "Provide a 10-paragraph detailed analysis of the impact of the printing press on the European Reformation, including theological, social, and political ramifications. Use a deep reasoning model. (Expect 20s hedge delay)"
    },
    {
        name: "Stress Test (Standard)",
        prompt: "Generate a 500-line Python implementation of a distributed hash table using the Chord protocol, including stabilization and finger tables. (Expect 4s hedge delay)"
    },
    {
        name: "Entity/JSON Extraction (Fast)",
        prompt: "Convert this list into a strictly valid JSON array of objects with keys 'api_name', 'tier', 'status': 'The Gemini Pro API offers a free tier for testing, whereas OpenAI GPT-4o is paid. QuantPi-X2 is currently in closed beta.'"
    }
];

async function start() {
    console.log("🌟 STARTING FREE-LLMS LIVE DEMO 🌟");
    console.log("--------------------------------------------------");
    console.log("MONITORING HEDGED EXECUTION:");
    console.log("1. Look for '[Router][Hedge] Launching...' logs.");
    console.error("2. If a provider takes > 8s (Standard) or > 20s (Reasoning),");
    console.error("   you will see a parallel provider launch automatically.");
    console.log("--------------------------------------------------");

    for (const task of tasks) {
        await runTask(task.name, task.prompt);
    }
}

start().catch(console.error);
