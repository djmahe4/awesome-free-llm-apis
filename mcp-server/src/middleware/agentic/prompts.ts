import fs from 'fs';
const fsp = fs.promises;
import path from 'path';
import { fileURLToPath } from 'url';

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
## 🔍 GROUNDING PROTOCOL
All file and artifact references in this prompt have been resolved and injected by the server pipeline.
When citing file content, prefix with \`[RETRIEVED]\` and reference the specific injected code block by filename.
Do not infer or reconstruct information that is not explicitly present in a resolved block.
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

async function loadPromptData(): Promise<PromptData | null> {
    try {
        const stats = await fsp.stat(JSON_PROMPT);
        const mtime = stats.mtimeMs;

        if (cachedPromptData && mtime === lastMtime) {
            return cachedPromptData;
        }

        const raw = await fsp.readFile(JSON_PROMPT, 'utf-8');
        try {
            const data = JSON.parse(raw);
            cachedPromptData = data as PromptData;
            lastMtime = mtime;
            return cachedPromptData;
        } catch (parseErr) {
            console.error(`[Prompts] Invalid JSON in prompt data: ${parseErr}`);
            return null;
        }
    } catch (err) {
        // Only log if it's not a standard file-missing error during tests
        if (!(err instanceof Error && err.message.includes('ENOENT'))) {
            console.error(`[Prompts] Error loading prompt data: ${err}`);
        }
        cachedPromptData = null;
        lastMtime = 0;
        return null;
    }
}

/**
 * Scoring sections based on keywords and assembles the prompt.
 * If explicitKeywords are provided, fuzzy tokenization of the context is bypassed (Strict Steering).
 */
export async function getIntelligentSystemPrompt(
    context?: string,
    explicitKeywords?: string[],
    memoryContext?: string,
    isSubtask: boolean = false
): Promise<string> {
    const data = await loadPromptData();
    if (!data) {
        return await getFallbackPrompt();
    }

    const introduction = data.introduction || "";
    let assembled = introduction;

    // Inject Workspace Memory at the very top of the assembled prompt for maximum attention
    if (memoryContext) {
        assembled += `\n\n## 🧠 WORKSPACE MEMORY\nRelevant prior knowledge for this workspace:\n${memoryContext}\n`;
    }

    if (!context) {
        const critical = data.sections
            .filter(s => s.level === 1)
            .map(s => `\n\n## ${s.title}\n\n${s.content}`)
            .join("");
        return `${assembled}${critical}`;
    }

    // Tokenize
    let tokens: Set<string>;
    const contextLower = (context || "").toLowerCase();

    if (explicitKeywords && explicitKeywords.length > 0) {
        // Strict Steering: Only use provided keywords, bypass fuzzy prompt tokenization
        tokens = new Set(explicitKeywords.map(k => k.toLowerCase()));
    } else {
        // Fuzzy Fallback: Tokenize context
        const stopwords = new Set(['and', 'the', 'with', 'your', 'from', 'that', 'this', 'for', 'are', 'you', 'was', 'were', 'been', 'have', 'has', 'had']);
        tokens = new Set(
            contextLower.split(/\W+/)
                .filter(t => t.length >= 3 && !stopwords.has(t))
        );
    }
    console.error(`[DEBUG] Tokens: ${Array.from(tokens).join(', ')}`);

    // Score sections
    const scoredSections = data.sections.map(section => {
        let score = 0;

        // Title match (5 points per word)
        const titleTokens = section.title.toLowerCase().split(/\W+/);
        titleTokens.forEach(tt => {
            if (tokens.has(tt)) score += 5;
        });

        // Keyword match (Stricter matching for high-precision extraction)
        section.keywords.forEach(kw => {
            const lowKw = kw.toLowerCase();
            if (tokens.has(lowKw)) {
                score += 3.0; // Higher weight for matching defined keywords
            } else if (lowKw.length > 4 && contextLower.includes(lowKw)) {
                score += 1.0;
            }
        });

        if (section.level === 1) score += 2.0;
        if (section.level === 2) score += 1.1; // Ensure single keyword match (3) + level boost (1.1) > threshold (4.0)

        const isReference = section.id === 'research_appendix' ||
            section.id === 'subsystem_reference_map' ||
            section.id === 'open_source_architecture_references';
        if (isReference) {
            const architecturalKeywords = [
                'rest', 'api', 'url', 'github', 'appendix', 'reference', 'map',
                'architecture', 'research', 'review', 'reviewer', 'implementation',
                'patterns', 'best practices', 'audit', 'python', 'javascript', 'golang', 'rust'
            ];
            architecturalKeywords.forEach(ak => {
                if (tokens.has(ak) || contextLower.includes(ak)) score += 5;
            });
        }

        return { ...section, score };
    });

    const relevant = scoredSections
        .filter(s => {
            if (s.score < 4) return false;
            // Suppress broad references in subtasks unless they match VERY strongly
            const isRef = s.id === 'research_appendix' ||
                s.id === 'subsystem_reference_map' ||
                s.id === 'open_source_architecture_references';
            if (isSubtask && isRef) {
                return s.score > 20;
            }
            return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, isSubtask ? 3 : 7); // Shorter budget for subtasks

    let currentSize = assembled.length;

    for (const section of relevant) {
        let content = section.content;

        const isRef = section.id === 'research_appendix' ||
            section.id === 'subsystem_reference_map' ||
            section.id === 'open_source_architecture_references';
        if (isRef) {
            // Split by any list item to separate category headers from links
            const parts = content.split(/\n(?=\s*- )/).map(p => p.trim()).filter(p => p.length > 0);

            const scoredEntries: { entry: string, entryScore: number }[] = [];
            let currentCategory = "";

            // Dynamic Thresholding: individual entries must have a stronger match
            // to survive if the section matches only on broad architectural terms.
            const minEntryScore = section.score > 12 ? 1.0 : 2.5;

            for (const part of parts) {
                if (part.includes('[')) {
                    // It's a link - score it with its category context
                    let entryScore = 0;
                    const entryLower = part.toLowerCase();
                    const contextText = (currentCategory + " " + part).toLowerCase();

                    // Score based on tokens in the link text AND category context
                    contextText.split(/\W+/).forEach(et => {
                        if (tokens.has(et)) {
                            // Give less weight to super common languages in references to avoid broad noise
                            if (['python', 'rust', 'js', 'javascript', 'ts', 'typescript', 'golang', 'go'].includes(et)) {
                                entryScore += 0.5;
                            } else {
                                entryScore += 2.0;
                            }
                        }
                    });

                    tokens.forEach(t => {
                        if (t.length > 3 && contextText.includes(t)) {
                            const boost = (['python', 'rust', 'javascript', 'typescript', 'golang'].includes(t)) ? 0.1 : 0.5;
                            entryScore += boost;
                            if (part.includes('LangGraph')) {
                                console.error(`[LANGGRAPH-DEBUG] Match Token: ${t} Boost: ${boost} CurrentScore: ${entryScore}`);
                            }
                        }
                    });

                    scoredEntries.push({ entry: part, entryScore });
                    if (entryScore >= 2.0) {
                        console.error(`[DEBUG] Entry: ${part.slice(0, 30)}... Score: ${entryScore} contextText: ${contextText.slice(0, 100)}`);
                    }
                } else {
                    // It's a category header - update context for subsequent links
                    currentCategory = part.replace(/^-\s*/, '');
                }
            }

            content = scoredEntries
                .filter(se => se.entryScore >= minEntryScore)
                .sort((a, b) => b.entryScore - a.entryScore)
                .slice(0, 15) // Higher diversity budget for categorized links
                .map(se => se.entry)
                .join('\n');
        }

        if (content.length > 0) {
            const block = `\n\n## ${section.title}\n\n${content}`;
            if (currentSize + block.length < PROMPT_CHAR_BUDGET) {
                assembled += block;
                currentSize += block.length;
            }
        }
    }

    const hasReferences = relevant.some(s =>
        s.id === 'research_appendix' || s.id === 'subsystem_reference_map'
    );
    if (hasReferences) {
        assembled += `\n\n${REFERENCE_SUGGESTION_PROTOCOL}`;
    }

    // Always inject Grounding Protocol for agentic consistency
    assembled += `\n\n${GROUNDING_PROTOCOL}`;

    return assembled;
}

async function getFallbackPrompt(): Promise<string> {
    try {
        await fsp.access(README);
        const data = await fsp.readFile(README, 'utf-8');
        if (data.length > MIN_PROMPT_LENGTH) return data;
    } catch { }

    return `You are the principal architect of a self-improving agent system.
Use queues (now, next, blocked, improve), verification-first execution, and file-based state.`;
}
