import fs from 'fs';
const fsp = fs.promises;
import path from 'path';

/** Minimum character length for a raw prompt file to be considered valid. */
const MIN_PROMPT_LENGTH = 500;
/** Maximum character budget for the dynamically assembled system prompt. */
const PROMPT_CHAR_BUDGET = 25000;

const BASE = path.resolve(
    process.env.AGENT_PROMPT_PATH ?? path.join(process.cwd(), '../../external/agent-prompt'),
);
const README = path.join(BASE, 'README.md');
const JSON_PROMPT = path.join(BASE, 'prompt.json');
const RAW = path.join(BASE, 'system-prompt-raw.md');

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
let cachedPromptPromise: Promise<string> | null = null;

/**
 * Resets the in-memory cache. Used primarily for testing or forced reloads.
 */
export function resetPromptCache(): void {
    cachedPromptData = null;
    cachedPromptPromise = null;
}

async function loadPromptData(): Promise<PromptData | null> {
    if (cachedPromptData) return cachedPromptData;

    try {
        await fsp.access(JSON_PROMPT);
        const data = JSON.parse(await fsp.readFile(JSON_PROMPT, 'utf-8'));
        cachedPromptData = data as PromptData;
        return cachedPromptData;
    } catch {
        return null; // Signals fallback should be used
    }
}

/**
 * Intelligent interpolation pipeline for subprompt selection.
 * Scores sections based on keyword density in context and assembles the prompt.
 */
export async function getIntelligentSystemPrompt(context?: string): Promise<string> {
    const data = await loadPromptData();
    if (!data) return await getFallbackPrompt();

    const introduction = data.introduction || "";
    if (!context) {
        // Return intro + level 1 (most critical) sections if no context
        const critical = data.sections
            .filter(s => s.level === 1)
            .map(s => `\n\n## ${s.title}\n\n${s.content}`)
            .join("");
        return `${introduction}${critical}`;
    }

    // Tokenize context - allowing 3-letter tokens for technical terms (api, url, git)
    const tokens = new Set(context.toLowerCase().split(/\W+/).filter(t => t.length > 2));
    
    // Score sections
    const scoredSections = data.sections.map(section => {
        let score = 0;
        
        // Exact title match weight
        const titleTokens = section.title.toLowerCase().split(/\W+/);
        titleTokens.forEach(tt => {
            if (tokens.has(tt)) score += 5;
        });

        // Keyword overlap weight
        section.keywords.forEach(kw => {
            if (tokens.has(kw)) score += 1;
        });

        // Level-based boost for critical architectural sections
        if (section.level === 1) score += 2;

        // NEW: Reference Booster - boost research/appendix sections for architectural queries
        const isReference = section.id === 'research_appendix' || section.id === 'subsystem_reference_map';
        if (isReference) {
            const architecturalKeywords = ['rest', 'api', 'url', 'github', 'appendix', 'reference', 'map', 'architecture'];
            architecturalKeywords.forEach(ak => {
                if (tokens.has(ak)) score += 10;
            });
        }

        return { ...section, score };
    });

    // Sort by score (descending) and filter relevant
    const relevant = scoredSections
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

    // Assemble within budget with Granular Filtering for Architectural References
    let assembled = introduction;
    let currentSize = assembled.length;

    for (const section of relevant) {
        let content = section.content;

        // Perform granular filtering for high-token reference maps
        if (section.id === 'research_appendix' || section.id === 'subsystem_reference_map') {
            const entries = content.split(/\n(?=- \[)/).map(e => e.trim()).filter(e => e.length > 0);
            const scoredEntries = entries.map(entry => {
                let entryScore = 0;
                const entryTokens = entry.toLowerCase().split(/\W+/);
                entryTokens.forEach(et => {
                    if (tokens.has(et)) entryScore += 1;
                });
                return { entry, entryScore };
            });

            // Keep only entries with actual matches, limit to top 10 to save tokens
            content = scoredEntries
                .filter(se => se.entryScore > 0)
                .sort((a, b) => b.entryScore - a.entryScore)
                .slice(0, 10)
                .map(se => se.entry)
                .join('\n\n');
        }

        if (content.length > 0) {
            const block = `\n\n## ${section.title}\n\n${content}`;
            if (currentSize + block.length < PROMPT_CHAR_BUDGET) {
                assembled += block;
                currentSize += block.length;
            }
        }
    }

    // Dynamic Protocol Injection: If references were included, add the suggestion protocol
    const hasReferences = relevant.some(s => 
        s.id === 'research_appendix' || s.id === 'subsystem_reference_map'
    );
    if (hasReferences) {
        assembled += `\n\n${REFERENCE_SUGGESTION_PROTOCOL}`;
    }

    return assembled;
}

async function getFallbackPrompt(): Promise<string> {
    // Tier 2: Raw Markdown File
    try {
        await fsp.access(RAW);
        const data = (await fsp.readFile(RAW, 'utf-8')).trim();
        if (data.length > MIN_PROMPT_LENGTH) return data;
    } catch { /* proceed to next tier */ }

    // Tier 3: Resilient README Extraction fallback
    try {
        await fsp.access(README);
        const txt = await fsp.readFile(README, 'utf-8');
        const extracted = extractFromMarkdown(txt, "You are the principal architect and builder");
        if (extracted && extracted.length > MIN_PROMPT_LENGTH) return extracted;
    } catch { /* proceed to next tier */ }

    // Tier 4: Static Fallback
    return `You are the principal architect of a self-improving agent system.
Use queues (now, next, blocked, improve), verification-first execution, and file-based state.`;
}

/** Legacy support for single-block extraction if needed elsewhere */
function extractFromMarkdown(txt: string, marker: string): string | null {
    const startIndex = txt.indexOf(marker);
    if (startIndex === -1) return null;
    const preContent = txt.slice(0, startIndex);
    const postContent = txt.slice(startIndex);
    const blockStart = preContent.lastIndexOf('```');
    const blockEnd = postContent.indexOf('```');
    if (blockStart !== -1 && blockEnd !== -1) {
        const blockText = txt.slice(blockStart, startIndex + blockEnd + 3);
        const match = blockText.match(/```(?:text|markdown|prompt)?\s*([\s\S]*?)\s*```/i);
        if (match) return match[1].trim();
    }
    return null;
}

async function getMostCapableAgentSystemPrompt(): Promise<string> {
    if (cachedPromptPromise) {
        return cachedPromptPromise;
    }

    cachedPromptPromise = (async () => {
        return await getIntelligentSystemPrompt();
    })();

    return cachedPromptPromise;
}
