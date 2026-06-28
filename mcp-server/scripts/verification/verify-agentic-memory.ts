/**
 * Verify that getIntelligentSystemPrompt produces a clean, context-aware prompt
 * for both full and subtask modes. The free LLM only gets workspace context —
 * NOT tool-usage instructions (the orchestrating agent handles that).
 */
import { getIntelligentSystemPrompt } from '../../src/pipeline/middlewares/prompts.js';

async function testAgenticPromptInjection() {
    console.log('--- Testing Agentic Prompt Assembly ---\n');

    // 1. Full prompt (non-subtask): should assemble relevant sections from prompt.json
    console.log('[1/3] Full prompt (non-subtask)...');
    const fullPrompt = await getIntelligentSystemPrompt({
        context: 'Explain how the vector memory indexer works',
        keywords: ['memory', 'vector', 'index'],
        isSubtask: false
    });

    const hasGrounding = fullPrompt.includes('GROUNDING');
    const hasNoToolProtocol = !fullPrompt.includes('MCP TOOL USAGE PROTOCOL');
    console.log(`  - Has GROUNDING block: ${hasGrounding}`);
    console.log(`  - No tool-usage instructions (correct): ${hasNoToolProtocol}`);
    console.log(`  - Char length: ${fullPrompt.length}\n`);
    console.log('Full prompt content:\n', fullPrompt, '\n');

    if (!hasGrounding || !hasNoToolProtocol) {
        throw new Error('Full prompt failed: unexpected content or missing grounding.');
    }

    // 2. Subtask prompt: should be minimal identity + relevant sections, no tool protocol
    console.log('[2/3] Subtask prompt (isSubtask=true)...');
    const subtaskPrompt = await getIntelligentSystemPrompt({
        context: 'Fix the memory leak in vector store',
        keywords: ['memory', 'leak', 'vector'],
        isSubtask: true
    });

    const isShorter = subtaskPrompt.length < fullPrompt.length;
    const subtaskNoToolProtocol = !subtaskPrompt.includes('MCP TOOL USAGE PROTOCOL');
    console.log(`  - Is shorter than full prompt: ${isShorter}`);
    console.log(`  - No tool-usage instructions (correct): ${subtaskNoToolProtocol}`);
    console.log(`  - Char length: ${subtaskPrompt.length}\n`);
    console.log('Subtask prompt content:\n', subtaskPrompt, '\n');

    if (!subtaskNoToolProtocol) {
        throw new Error('Subtask prompt contains tool protocol — should not.');
    }

    // 3. With memory context: memory block should be prepended
    console.log('[3/3] Memory injection...');
    const promptWithMemory = await getIntelligentSystemPrompt({
        context: 'refactor the router',
        memory: 'Prior work: router was refactored in PR #42 to use middleware chain.'
    });

    const hasMemoryBlock = promptWithMemory.includes('WORKSPACE MEMORY');
    console.log(`  - Has memory block: ${hasMemoryBlock}`);
    console.log(`  - Char length: ${promptWithMemory.length}\n`);
    console.log('Prompt with memory content:\n', promptWithMemory, '\n');

    if (!hasMemoryBlock) {
        throw new Error('Memory context was not injected into prompt.');
    }

    console.log('✅ All checks passed. Free LLM prompts are clean and context-only.');
}

testAgenticPromptInjection().catch(err => {
    console.error('❌ Verification FAILED:', err.message);
    process.exit(1);
});
