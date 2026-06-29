
/**
 * Agentic Context & Token Simulation Script
 * Simulates the full context injection pipeline (Long-term, Short-term, and Session memory).
 * Run with: npx tsx scripts/evaluation/simulate-agentic-context.ts
 */
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import { getEncoding } from 'js-tiktoken';
import { ContextGatherer } from '../../src/pipeline/middlewares/context-gatherer.js';
import { PROJECTS_DIR, SESSION_STATE_HEADER, KNOWLEDGE_FILE } from '../../src/pipeline/middlewares/constants.js';
import { getIntelligentSystemPrompt } from '../../src/pipeline/middlewares/prompts.js';

const enc = getEncoding("cl100k_base");

const WORKSPACE = process.cwd();
const SESSION_ID = 'simulation-session-123';
const QUERY = 'How does the AgenticMiddleware handle task decomposition and iteration?';
const KEYWORDS = ['AgenticMiddleware', 'decomposeGoal', 'MAX_SUBTASKS'];

function countTokens(text: string): number {
    return enc.encode(text).length;
}

async function getMockSemanticMemory(): Promise<string> {
    // In a real run, this comes from memoryManager.search(wsHash, query)
    // We simulate a few relevant snippets from "long term" storage
    return [
        "- File: src/pipeline/middleware.ts | interface Middleware { execute(context, next) }",
        "- File: src/utils/debounce.ts | export function debounce(fn, wait) { ... }",
        "- File: src/memory/index.ts | export const memoryManager = new MemoryManager();"
    ].join('\n');
}

async function getSessionMemory(sessionId: string): Promise<string> {
    const knowledgePath = path.join(PROJECTS_DIR, sessionId, KNOWLEDGE_FILE);
    try {
        const content = await fs.readFile(knowledgePath, 'utf-8');
        // Clean up workspace comments for reporting
        return content.replace(/<!--[\s\S]*?-->/g, '').trim();
    } catch {
        return "No prior knowledge for this session.";
    }
}

async function getDirectoryTree(dirPath: string, maxDepth = 2, currentDepth = 0): Promise<string> {
    if (currentDepth > maxDepth) return '';
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        let tree = '';
        const indent = '  '.repeat(currentDepth);
        for (const entry of entries) {
            if (['node_modules', '.git', 'dist', 'build', '.next', 'venv', '__pycache__'].includes(entry.name)) continue;
            tree += `${indent}- ${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
            if (entry.isDirectory()) {
                tree += await getDirectoryTree(path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
            }
        }
        return tree;
    } catch {
        return '';
    }
}

async function prepareSession(sessionId: string) {
    const projectDir = path.join(PROJECTS_DIR, sessionId);
    await fs.mkdir(projectDir, { recursive: true });
    const knowledgePath = path.join(projectDir, KNOWLEDGE_FILE);
    const mockKnowledge = `
# Knowledge
<!-- workspace: ${process.cwd()} -->

### AgenticMiddleware Design
**session:** prev-session-456  **ts:** 2026-05-14T10:00:00Z
**what:**
- Decided to limit subtasks to 2 to prevent over-iteration.
- Implemented loop protection at 10 iterations.
- Added research intent detection to auto-enable google_search.
**files:**
- \`src/middleware/agentic/agentic-middleware.ts\`
- \`src/middleware/agentic/prompts.ts\`
`;
    await fs.writeFile(knowledgePath, mockKnowledge, 'utf-8');
}

async function simulate() {
    await prepareSession(SESSION_ID);
    console.log('=== Agentic Context Simulation ===');
    console.log(`Workspace : ${WORKSPACE}`);
    console.log(`Session   : ${SESSION_ID}`);
    console.log(`Query     : "${QUERY}"\n`);

    // 1. Gather Short-Term (Grep) Context
    const grepStart = Date.now();
    // Use keywords that are VERY likely to be found
    const simKeywords = ['Middleware', 'session', 'agentic', 'gatherContext'];
    const grepResults = await ContextGatherer.gatherContext({
        workspaceRoot: WORKSPACE,
        query: QUERY,
        keywords: simKeywords,
        limit: 5
    });
    const grepTime = Date.now() - grepStart;
    const grepContextStr = grepResults.join('\n');

    // 2. Directory Tree
    const dirTree = await getDirectoryTree(WORKSPACE);

    // 3. Gather Long-Term (Semantic) Memory
    const semanticMemory = await getMockSemanticMemory();

    // 4. Gather Session (Distilled) Memory
    const sessionMemory = await getSessionMemory(SESSION_ID);

    // 5. Assemble System Prompt (AgenticMiddleware style)
    const workspaceContext = `Project Structure:\n${dirTree}\n\nRelevant File Snippets:\n${grepContextStr}`;
    
    const systemPromptBase = await getIntelligentSystemPrompt({
        context: QUERY,
        keywords: ['agentic', 'orchestration', ...simKeywords],
        memory: semanticMemory,
        workspace: workspaceContext,
        isSubtask: false
    });
    
    const highLevelSteps = `\n\n## HIGH-LEVEL STEPS\nWhen responding to a task, always begin with a numbered list of at most **2** high-level steps.`;
    const groundingGate = `\n\n## 📖 READ-FIRST GATE ACTIVATED\nA README.md or project documentation is detected in the workspace root.\nYou MUST verify all assertions against the provided context blocks in this prompt.`;
    
    const fullSystemPrompt = `${systemPromptBase}${highLevelSteps}${groundingGate}`;

    // 6. Assemble User Message Context (StructuralMarkdownMiddleware style)
    const contextHeader = `${SESSION_STATE_HEADER}\n# INTERNAL DIAGNOSTICS (session ${SESSION_ID})\n${sessionMemory}\n\n# RESPONSE FORMAT\nReply only in clean Markdown...`;
    const finalUserMessage = `${contextHeader}\n\n${QUERY}`;

    // --- REPORTING ---
    console.log('--- Token Breakdown ---');
    
    const tBase = countTokens(systemPromptBase.split('Project Structure:')[0]);
    const tTree = countTokens(dirTree);
    const tShort = countTokens(grepContextStr);
    const tLong = countTokens(semanticMemory);
    const tSteps = countTokens(highLevelSteps + groundingGate);
    const tSession = countTokens(contextHeader);
    const tQuery = countTokens(QUERY);
    const tTotal = countTokens(fullSystemPrompt) + countTokens(finalUserMessage);

    console.log(`[System] Base Instructions    : ${tBase.toString().padStart(5)} tokens`);
    console.log(`[System] Directory Tree       : ${tTree.toString().padStart(5)} tokens`);
    console.log(`[System] Short-Term (Grep)    : ${tShort.toString().padStart(5)} tokens (${grepTime}ms)`);
    console.log(`[System] Long-Term (Semantic) : ${tLong.toString().padStart(5)} tokens`);
    console.log(`[System] Control Structures   : ${tSteps.toString().padStart(5)} tokens`);
    console.log(`[User]   Session Memory       : ${tSession.toString().padStart(5)} tokens`);
    console.log(`[User]   Original Query       : ${tQuery.toString().padStart(5)} tokens`);
    console.log('-----------------------');
    console.log(`TOTAL PROMPT OVERHEAD         : ${tTotal.toString().padStart(5)} tokens`);
    console.log(`(Approx cost: $${((tTotal / 1000000) * 0.15).toFixed(6)} for Gemini 1.5 Flash)`);

    console.log('\n--- Sample Short-Term Snippet (Full) ---');
    if (grepContextStr.length > 0) {
        console.log(grepContextStr);
    } else {
        console.log('(No snippets found - check if rg/grep is in PATH)');
    }
}

simulate().catch(console.error);
