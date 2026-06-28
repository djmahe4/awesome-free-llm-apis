import { promises as fs } from 'fs';
import path from 'path';
import { ProviderRegistry } from '../../providers/registry.js';
import { getMessageContent } from '../../utils/MessageUtils.js';

export type IntentType = 'CLEAR_TASK' | 'QUESTION' | 'CONFUSED';

export interface ClarificationResult {
    type: 'CLARIFICATION_NEEDED';
    markdown: string;
}

/**
 * Heuristic intent classification of user prompt.
 * Ensures robust code indicators override confusion markers.
 */
export function classifyIntent(prompt: string): IntentType {
    if (!prompt || prompt.trim() === '') return 'CONFUSED';

    const questionWords = /\b(what|how|why|where|when|does|is|are|can|could|who|explain)\b/i;
    const taskVerbs = /\b(add|create|fix|write|refactor|update|delete|implement|run|test|compile|check|make|modify|setup)\b/i;
    
    // Clarified confusion markers - removed 'problem' and 'issue' to avoid false positives
    const confusionMarkers = /\b(not sure|dont know|don't know|do not know|something seems|seems off|feels weird|feels odd|weird|off)\b/i;
    
    // Codebase indicators: file extensions, symbols in backticks, or non-stop-word capital symbols
    const fileExtensionPattern = /\b[a-zA-Z0-9_\-\/\\.]+\.(ts|js|py|go|rs|md|json|sh|ps1|yml|yaml)\b/;
    const backtickSymbolPattern = /`[a-zA-Z0-9_\-\/\\.+]+`/;
    
    const capitals = prompt.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g) || [];
    const hasCapitalSymbol = capitals.some(word => 
        !/^(what|how|why|where|when|does|is|are|can|could|who|explain|add|create|fix|write|refactor|update|delete|implement|run|test|compile|check|make|modify|setup|the|this|that|here|there|some|them|they|have|has|had|does|do|did|not|sure|something|seems|feels|odd|weird|maybe|know|please|would|should|could)$/i.test(word)
    );

    const hasFile = fileExtensionPattern.test(prompt) || backtickSymbolPattern.test(prompt) || hasCapitalSymbol;
    const hasTask = taskVerbs.test(prompt);
    const hasQuestion = questionWords.test(prompt) && !hasTask;
    const hasConfusion = confusionMarkers.test(prompt);

    // If it has a question and a question mark, or starts with a strong question word, it's a question, overriding confusion
    const isStrongQuestion = hasQuestion && (prompt.includes('?') || /^\s*(what|how|why|where|when|who|explain)/i.test(prompt));

    // Codebase referents override confusion markers
    if (hasFile && (hasTask || hasQuestion)) {
        return hasQuestion ? 'QUESTION' : 'CLEAR_TASK';
    }

    if (isStrongQuestion) return 'QUESTION';
    if (hasConfusion) return 'CONFUSED';
    if (hasQuestion) return 'QUESTION';
    if (hasTask) return 'CLEAR_TASK';

    // No clear task verbs, no question words, and no code indicators -> CONFUSED
    if (!hasTask && !hasQuestion && !hasFile) return 'CONFUSED';

    return 'CLEAR_TASK';
}

/**
 * Builds a filtered, depth-limited repository snapshot to prevent OOM and context bloating.
 */
export async function buildRepoSnapshot(workspaceRoot: string): Promise<string> {
    const ignoredDirs = new Set([
        '.git', 'node_modules', 'dist', 'build', 'venv', '.venv',
        '.free-llm-mcp', '.gemini', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
    ]);

    const snapshotLines: string[] = [];

    async function walk(dir: string, currentDepth: number) {
        if (currentDepth > 2) return;

        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoredDirs.has(entry.name) || entry.name.startsWith('.')) continue;

                const relativePath = path.relative(workspaceRoot, path.join(dir, entry.name));
                const indent = '  '.repeat(currentDepth);

                if (entry.isDirectory()) {
                    snapshotLines.push(`${indent}📁 ${relativePath}/`);
                    await walk(path.join(dir, entry.name), currentDepth + 1);
                } else if (entry.isFile()) {
                    snapshotLines.push(`${indent}📄 ${relativePath}`);
                }
            }
        } catch {
            // Safe ignore dir read errors
        }
    }

    await walk(workspaceRoot, 0);
    return `### Repository Structure\n${snapshotLines.join('\n')}`;
}

/**
 * Disambiguates a confused user prompt using a bare, low-latency LLM call.
 */
export async function disambiguateConfusedIntent(prompt: string, workspaceRoot?: string): Promise<ClarificationResult> {
    let repoSnapshot = '';
    if (workspaceRoot) {
        repoSnapshot = await buildRepoSnapshot(workspaceRoot);
    }

    const registry = ProviderRegistry.getInstance();
    // Exclude siliconflow per user request
    const provider = registry.getAvailableProviders().find(p => p.id !== 'siliconflow') || registry.getProvider('gemini');
    if (!provider) {
        return {
            type: 'CLARIFICATION_NEEDED',
            markdown: `## ❓ I need a bit more detail\nI could not find an active LLM provider. Could you clarify your task?`
        };
    }

    const CLARIFICATION_SYSTEM_PROMPT = `You are a helpful assistant. The user's request is unclear.
Your only job is to ask for clarification. Do NOT attempt to complete any task.
Return ONLY a markdown block in this format:
## ❓ I need a bit more detail
**I think you might want to:** [your best guess]
**To proceed, could you clarify:**
- [missing detail 1]
- [missing detail 2]`;

    let graphHints = '';
    if (workspaceRoot) {
        try {
            const graphPath = path.join(workspaceRoot, '.free-llm-mcp', 'repo_graph.json');
            const { RepositoryGraph, semanticScore } = await import('../../memory/dependency-scanner.js');
            const graphData = JSON.parse(await fs.readFile(graphPath, 'utf-8'));
            const graph = RepositoryGraph.deserialize(workspaceRoot, graphData);
            const scored = semanticScore(prompt, graph, true, 3);
            if (scored.length > 0) {
                graphHints = `\n\n**Most relevant files (by dependency graph):**\n` +
                    scored.map(s => `- \`${s.node.id}\` (${s.reason})`).join('\n');
            }
        } catch { /* graph not ready */ }
    }

    try {
        const userPrompt = `Here is the repository structure:\n${repoSnapshot}${graphHints}\n\nUser said: "${prompt}"`;
        const response = await provider.chat({
            model: provider.models[0]?.id,
            messages: [
                { role: 'system', content: CLARIFICATION_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.2,
            max_tokens: 256
        });

        const choice = response.choices?.[0];
        const content = getMessageContent(choice?.message) || 'Could you please clarify your request?';

        return {
            type: 'CLARIFICATION_NEEDED',
            markdown: content
        };
    } catch (err: any) {
        console.error(`[IntentClassifier] Failed clarification call:`, err);
        return {
            type: 'CLARIFICATION_NEEDED',
            markdown: `## ❓ I need a bit more detail\nYour request is unclear. Could you provide more details about the files or tasks you want to execute?`
        };
    }
}
