import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimum character length for a raw prompt file to be considered valid. */
const MIN_PROMPT_LENGTH = 500;
/** Maximum character budget for the dynamically assembled system prompt. */
const PROMPT_CHAR_BUDGET = 12000;

// Resolve the base directory relative to this file, not process.cwd(),
// so it works correctly regardless of where the process is launched from.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = path.resolve(
    process.env.AGENT_PROMPT_PATH ?? path.join(__dirname, '../../../../external/agent-prompt'),
);
const README = path.join(BASE, 'README.md');
const JSON_PROMPT = path.join(BASE, 'prompt.json');

/**
 * Protocol injected when architectural reference sections are present.
 */
const REFERENCE_SUGGESTION_PROTOCOL = `
## 🔗 REFERENCE SUGGESTION PROTOCOL
When your output contains matches from the 'RESEARCH APPENDIX' or 'SUBSYSTEM REFERENCE MAP', you MUST:
1. Provide the direct URL to the project/appendix item.
2. Briefly explain why this reference is relevant to the user's current task.
3. Use the following format for references:
   - [Project Name](URL): Description / Useful pattern.
`;

/**
 * Mandatory Grounding Protocol (v1.0.4)
 * Forces the model to explicitly verify its source before answering.
 */
const GROUNDING_PROTOCOL = `
## 🔍 GROUNDING
- Cite files as: \`[RETRIEVED] filename\` — only from injected \`[Context]\` blocks.
- No \`[Context]\` block for a topic = pipeline found no match. Say: "Workspace context unavailable for [X]."
- Never infer file content from training data. Ask the user to share the file instead.
`;



interface PromptSection {
    id: string;
    title: string;
    content: string;
    level: number;
    keywords: string[];
}

interface PromptData {
    metadata: { version: string };
    introduction: string;
    sections: PromptSection[];
}

let cachedPromptData: PromptData | null = null;
let lastMtime: number = 0;

/**
 * Resets the in-memory cache. Used primarily for testing or forced reloads.
 */
export function resetPromptCache(): void {
    cachedPromptData = null;
    lastMtime = 0;
}

/**
 * Version-aware Emergency Fallback Prompt.
 * Used only when the configuration pipeline (prompt.json) is critically broken.
 */
const EMERGENCY_PROMPT_V1 = `
# ⚠️ SYSTEM ALERT: RUNNING IN DEGRADED FALLBACK MODE
The primary agent configuration (prompt.json) could not be loaded. 
Reliability and workspace-awareness may be degraded.

## ROLE
You are the principal architect of a self-improving agentic operating system.
Your goal is to build, coordinate, and verify work across the full range of computer tasks.

## MANDATORY PROTOCOLS
1. **Verification-First**: Never mark a task as done without running verification scripts.
2. **File-Based State**: Maintain tasks.md and plan.md as the source of truth.
3. **Tool-First**: ALWAYS check memory via \`manage_memory\` before starting project tasks.
4. **Closed-Loop**: goal -> task graph -> execution -> verification -> memory update.
`;


async function loadPromptData(): Promise<PromptData | null> {
    try {
        const stats = await fsp.stat(JSON_PROMPT);
        const mtime = stats.mtimeMs;

        if (cachedPromptData && mtime === lastMtime) {
            return cachedPromptData;
        }

        const raw = await fsp.readFile(JSON_PROMPT, 'utf-8');
        if (raw.length < MIN_PROMPT_LENGTH) {
            return null;
        }

        const data = JSON.parse(raw);
        cachedPromptData = data;
        lastMtime = mtime;
        return data;
    } catch (e) {
        return null;
    }
}


function getMinimalIdentity(data: PromptData): string {
    const firstPara = (data.introduction || "").split('\n\n')[0];
    return `# ROLE\n${firstPara}\n`;
}

/**
 * Scoring sections based on keywords and assembles the prompt.
 * If explicitKeywords are provided, fuzzy tokenization of the context is bypassed (Strict Steering).
 */
export interface PromptOptions {
    context?: string;
    keywords?: string[];
    memory?: string;
    workspace?: string;
    isSubtask?: boolean;
}

/**
 * Assembles a contextually relevant system prompt.
 * Uses strict keyword steering if provided, otherwise falls back to fuzzy tokenization.
 */
export async function getIntelligentSystemPrompt(
    contextOrOptions: string | PromptOptions = "",
    explicitKeywords?: string[],
    memoryContext?: string,
    isSubtask: boolean = false
): Promise<string> {
    let context = "";
    let workspaceContext: string | undefined;
    if (typeof contextOrOptions === 'object') {
        context = contextOrOptions.context || "";
        explicitKeywords = contextOrOptions.keywords;
        memoryContext = contextOrOptions.memory;
        workspaceContext = contextOrOptions.workspace;
        isSubtask = contextOrOptions.isSubtask || false;
    } else {
        context = contextOrOptions;
    }
    
    const contextLower = context.toLowerCase();
    const data = await loadPromptData();
    if (!data) {
        try {
            // Tier 2 Fallback: Load raw README if JSON is missing/corrupt
            const readme = await fsp.readFile(README, 'utf-8');
            return readme + "\n\n" + GROUNDING_PROTOCOL;
        } catch (e) {
            // Tier 3 Fallback: Hardcoded emergency prompt
            return EMERGENCY_PROMPT_V1;
        }
    }

    const introduction = isSubtask ? getMinimalIdentity(data) : (`# ROLE\n${data.introduction || ""}\n`);
    let assembled = introduction;

    // Inject Workspace Memory and File Context at the very top of the assembled prompt
    if (workspaceContext) {
        const cappedWorkspace = workspaceContext.length > 5000 ? workspaceContext.slice(0, 5000) + "\n... (truncated)" : workspaceContext;
        assembled = `## 📂 WORKSPACE CONTEXT\n<workspace_context_isolation_gate>\nRelevant file snippets and directory structures:\n${cappedWorkspace}\n</workspace_context_isolation_gate>\n\n` + assembled;
    }
    if (memoryContext) {
        const cappedMemory = memoryContext.length > 2000 ? memoryContext.slice(0, 2000) + "\n... (truncated)" : memoryContext;
        assembled = `## 🧠 WORKSPACE MEMORY\n<memory_context_isolation_gate>\nRelevant prior knowledge for this workspace:\n${cappedMemory}\n</memory_context_isolation_gate>\n\n` + assembled;
    }

    if (!context && (!explicitKeywords || explicitKeywords.length === 0)) {
        const assembled = data.introduction + "\n" + data.sections
        .filter(s => s.level === 1)
        .map(s => {
            const content = s.content.length > 5000 ? s.content.substring(0, 4900) + "\n\n[...SECTION TRUNCATED...]\n" : s.content;
            return `\n\n## ${s.title}\n\n${content}`;
        })
        .join("");
        
        return `${assembled}${GROUNDING_PROTOCOL}`;
    }

    // Tokenize
    const tokens = new Set<string>();
    const stopwords = new Set(['and', 'the', 'with', 'your', 'from', 'that', 'this', 'for', 'are', 'you', 'was', 'were', 'been', 'have', 'has', 'had']);
    
    if (explicitKeywords && explicitKeywords.length > 0) {
        explicitKeywords.forEach(k => tokens.add(k.toLowerCase()));
    }
    
    if (contextLower) {
        contextLower.split(/\W+/).forEach(t => {
            if (t.length >= 3 && !stopwords.has(t)) tokens.add(t);
        });
    }

    // Score sections
    const scoredSections = data.sections.map(section => {
        let score = 0;
        let matches: string[] = [];
        
        // 1. Explicit Keywords (Highest Priority)
        if (explicitKeywords) {
            const titleLower = section.title.toLowerCase();
            explicitKeywords.forEach(kw => {
                const kwLower = kw.toLowerCase();
                if (section.keywords.includes(kwLower)) {
                    score += 10.0;
                    matches.push(`explicit:${kw}`);
                }
                if (titleLower.includes(kwLower)) {
                    score += 10.0;
                    matches.push(`explicit-title:${kw}`);
                }
            });
        }

        // 2. Title relevance: restrict to explicit keywords if provided, else use context tokens
        const titleMatchSource = (explicitKeywords && explicitKeywords.length > 0) 
            ? new Set(explicitKeywords.map(k => k.toLowerCase())) 
            : tokens;
            
        if (section.title.toLowerCase().split(/\W+/).some(t => titleMatchSource.has(t))) {
            score += 5.0;
        }

        // 3. Keyword Density Normalization: prevent "bloated" sections from matching everything
        const keywordCount = section.keywords.length;
        const kwFactor = keywordCount > 25 ? (25 / keywordCount) : 1.0;

        section.keywords.forEach(kw => {
            const lowKw = kw.toLowerCase();
            if (tokens.has(lowKw)) {
                const added = 2.0 * kwFactor;
                score += added;
            } else if (lowKw.length > 4 && contextLower.includes(lowKw)) {
                const added = 0.5 * kwFactor;
                score += added;
            }
        });

        if (section.level === 1) score += 3.0; // Moderate boost for major categories; needs a keyword match for inclusion in dense context
        if (section.level === 2) score += 1.5;

        const isReference = ['research_appendix', 'subsystem_reference_map', 'open_source_architecture_references'].includes(section.id);
        if (isReference) {
            const architecturalKeywords = ['rest', 'api', 'url', 'github', 'architecture', 'patterns', 'audit'];
            architecturalKeywords.forEach(ak => { if (tokens.has(ak) || contextLower.includes(ak)) score += 5; });
        }

        const scored = { ...section, score };
        return scored;
    });

    const minScore = 5.0; // Hardened threshold for high-density synthesis
    const relevant = scoredSections
        .filter(s => {
            if (s.score < minScore) return false;
            const isRef = ['research_appendix', 'subsystem_reference_map', 'open_source_architecture_references'].includes(s.id);
            if (isSubtask && isRef) return s.score > 20;
            return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, isSubtask ? 3 : 7);

    // Reserve 1000 chars for introduction and protocols
    const budgetLimit = (isSubtask ? 8000 : PROMPT_CHAR_BUDGET) - 1000;
    let currentSize = assembled.length;

    for (const section of relevant) {
        let content = section.content;
        const isRef = ['research_appendix', 'subsystem_reference_map', 'open_source_architecture_references'].includes(section.id);
        
        if (isRef) {
            const parts = content.split(/\n(?=\s*- )/).map(p => p.trim()).filter(p => p.length > 0);
            const scoredEntries: { entry: string, entryScore: number }[] = [];
            let currentCategory = "";
            // High-score sections (explicitly requested) get full content baseline, except reference maps.
            const isReferenceMap = section.id.includes('reference') || section.id.includes('appendix');
            const minEntryScore = (section.score > 20 && !isReferenceMap) ? 0 : (section.score > 12 ? 1.0 : 2.5);

            for (const part of parts) {
                if (part.trim().startsWith('-')) {
                    let entryScore = 0;
                    const contextText = (currentCategory + " " + part).toLowerCase();
                    contextText.split(/\W+/).forEach(et => {
                        if (tokens.has(et)) entryScore += (['python', 'rust', 'javascript', 'typescript', 'go'].includes(et)) ? 0.5 : 2.0;
                    });
                    tokens.forEach(t => { if (t.length > 3 && contextText.includes(t)) entryScore += 0.5; });
                    scoredEntries.push({ entry: part, entryScore });
                } else {
                    currentCategory = part.replace(/^-\s*/, '');
                }
            }

            content = scoredEntries
                .filter(se => se.entryScore >= minEntryScore)
                .sort((a, b) => b.entryScore - a.entryScore)
                .slice(0, 15)
                .map(se => se.entry)
                .join('\n');
        }

        if (content.length > 0) {
            const header = `\n\n## ${section.title}\n\n`;
            const remainingBudget = budgetLimit - currentSize;
            
            if (remainingBudget > header.length + 50) {
                let blockContent = content;
                const MAX_SECTION_SIZE = isSubtask ? 2000 : 4000;
                if (blockContent.length > MAX_SECTION_SIZE) {
                    blockContent = blockContent.substring(0, MAX_SECTION_SIZE) + "\n[...SECTION TRUNCATED...]\n";
                }
                
                if (header.length + blockContent.length > remainingBudget) {
                    blockContent = blockContent.slice(0, Math.max(0, remainingBudget - header.length - 20)) + "\n[...TRUNCATED...]";
                }
                
                const block = header + blockContent;
                assembled += block;
                currentSize += block.length;
            }
        }
    }

    if (relevant.some(s => ['research_appendix', 'subsystem_reference_map'].includes(s.id))) {
        assembled += `\n\n${REFERENCE_SUGGESTION_PROTOCOL}`;
    }

    assembled += `\n\n${GROUNDING_PROTOCOL}`;
    return assembled;
}
