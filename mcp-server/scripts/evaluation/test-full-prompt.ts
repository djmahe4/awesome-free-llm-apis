import { ContextGatherer } from '../../src/middleware/agentic/context-gatherer.js';
import { getIntelligentSystemPrompt } from '../../src/middleware/agentic/prompts.js';

async function main() {
    const workspaceRoot = "/home/kali/Desktop/Study-AI-Agent"; //"c:\\Users\\mahes\\OneDrive\\Desktop\\Python-Projects\\Study-AI-Agent";
    const query = "Explain the implementation of `core/gemini_processor.py` and `SimpleGeminiCache` in this project.";

    console.log(`Gathering context...`);

    // 1. Gather the snippets
    const results = await ContextGatherer.gatherContext({
        query,
        workspaceRoot,
        limit: 2 // Small limit for demonstration
    });

    const workspaceContext = results.join('\n');

    // 2. Build the intelligent system prompt
    console.log(`Assembling full system prompt...\n`);
    const fullPrompt = await getIntelligentSystemPrompt({
        context: query,
        keywords: ["GeminiProcessor", "SimpleGeminiCache"],
        workspace: workspaceContext,
        isSubtask: false
    });

    console.log('--- FINAL PROMPT START ---');
    console.log(fullPrompt);
    console.log('--- FINAL PROMPT END ---');
}

main().catch(console.error);
