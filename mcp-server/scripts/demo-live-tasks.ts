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
        name: "Sophisticated Coding",
        prompt: "Write a high-performance TypeScript implementation of a thread-safe 'Circuit Breaker' pattern with exponential backoff and localized state management."
    },
    {
        name: "Deep Reasoning",
        prompt: "A man is looking at a photograph. His friend asks, 'Who is it?' The man replies, 'Brothers and sisters I have none, but that man's father is my father's son.' Who is in the photograph? Explain the logic."
    },
    {
        name: "Entity/JSON Extraction",
        prompt: "Convert this list into a strictly valid JSON array of objects with keys 'api_name', 'tier', 'status': 'The Gemini Pro API offers a free tier for testing, whereas OpenAI GPT-4o is paid. QuantPi-X2 is currently in closed beta.'"
    },
    {
        name: "Full Project Decomposition",
        prompt: "I need to build a secure document indexing service. First, design a vector database schema using Pinecone. Second, provide a Node.js snippet for chunking PDF text. Finally, describe the security protocol for encrypting PII at rest."
    },
    {
        name: "Extreme Stress Test",
        prompt: "I need you to write a highly detailed technical specification for a multi-tenant Kubernetes architecture spanning AWS and Azure. It must include exact YAML manifests for: 1) Cross-cluster Service Mesh using Linkerd. 2) GitOps deployment strategy using ArgoCD enforcing OPA Gatekeeper policies. 3) CockroachDB StatefulSets spread across 3 regions with zero-trust networking. Explain the failover mechanisms in extreme detail. Furthermore, validate this against ISO 27001 compliance standards. Provide code for the custom admission controllers in Golang. Ensure that you explain the rationale behind every single configuration option. Include performance benchmarking strategies for the ingress controllers."
    }
];

async function start() {
    console.log("🌟 STARTING FREE-LLMS LIVE DEMO 🌟");
    console.log("Using Production build IDs: Qwen3 Coder, DeepSeek R1, Gemma 3/4");

    for (const task of tasks) {
        await runTask(task.name, task.prompt);
    }
}

start().catch(console.error);
