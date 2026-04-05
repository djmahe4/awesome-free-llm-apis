import fs from 'fs';
const fsp = fs.promises;
import path from 'path';
import { fileURLToPath } from 'url';

/** Minimum character length for a raw prompt file to be considered valid. */
const MIN_PROMPT_LENGTH = 500;
/** Maximum character budget for the dynamically assembled system prompt. */
const PROMPT_CHAR_BUDGET = 25000;

// Resolve the base directory relative to this file, not process.cwd(),
// so it works correctly regardless of where the process is launched from.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = path.resolve(
    process.env.AGENT_PROMPT_PATH ?? path.join(__dirname, '../../../../external/agent-prompt'),
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
export async function getIntelligentSystemPrompt(context?: string, explicitKeywords?: string[]): Promise<string> {
    const data = await loadPromptData();
    if (!data) {
        return await getFallbackPrompt();
    }

    const introduction = data.introduction || "";
    if (!context) {
        const critical = data.sections
            .filter(s => s.level === 1)
            .map(s => `\n\n## ${s.title}\n\n${s.content}`)
            .join("");
        return `${introduction}${critical}`;
    }

    // Tokenize
    let tokens: Set<string>;
    const contextLower = (context || "").toLowerCase();

    if (explicitKeywords && explicitKeywords.length > 0) {
        // Strict Steering: Only use provided keywords, bypass fuzzy prompt tokenization
        tokens = new Set(explicitKeywords.map(k => k.toLowerCase()));
    } else {
        // Fuzzy Fallback: Tokenize context
        tokens = new Set(contextLower.split(/\W+/).filter(t => t.length > 2));
    }

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

        if (section.level === 1) score += 2;

        const isReference = section.id === 'research_appendix' || section.id === 'subsystem_reference_map';
        if (isReference) {
            const architecturalKeywords = ['rest', 'api', 'url', 'github', 'appendix', 'reference', 'map', 'architecture', 'research'];
            architecturalKeywords.forEach(ak => {
                if (tokens.has(ak) || contextLower.includes(ak)) score += 5;
            });
        }

        return { ...section, score };
    });

    const relevant = scoredSections
        .filter(s => s.score >= 3)
        .sort((a, b) => b.score - a.score);

    let assembled = introduction;
    let currentSize = assembled.length;

    for (const section of relevant) {
        let content = section.content;

        if (section.id === 'research_appendix' || section.id === 'subsystem_reference_map') {
            // Split by lines starting with "- [" or "  - [" and only keep actual link entries
            const entries = content.split(/\n(?=\s*- \[)/).map(e => e.trim()).filter(e => e.length > 0 && e.includes('['));
            const scoredEntries = entries.map(entry => {
                let entryScore = 0;
                const entryTokens = entry.toLowerCase().split(/\W+/);
                entryTokens.forEach(et => {
                    if (tokens.has(et)) entryScore += 2;
                });
                tokens.forEach(t => {
                    if (t.length > 4 && entry.toLowerCase().includes(t)) entryScore += 1;
                });
                return { entry, entryScore };
            });

            content = scoredEntries
                .filter(se => se.entryScore >= 2)
                .sort((a, b) => b.entryScore - a.entryScore)
                .slice(0, 5) // High precision: only top 5 necessary references
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

    const hasReferences = relevant.some(s =>
        s.id === 'research_appendix' || s.id === 'subsystem_reference_map'
    );
    if (hasReferences) {
        assembled += `\n\n${REFERENCE_SUGGESTION_PROTOCOL}`;
    }

    return assembled;
}

async function getFallbackPrompt(): Promise<string> {
    try {
        await fsp.access(README);
        const data = await fsp.readFile(README, 'utf-8');
        if (data.length > MIN_PROMPT_LENGTH) return data;
    } catch { }

    try {
        await fsp.access(RAW);
        const data = (await fsp.readFile(RAW, 'utf-8')).trim();
        if (data.length > MIN_PROMPT_LENGTH) return data;
    } catch { }

    return `You are the principal architect of a self-improving agent system.
Use queues (now, next, blocked, improve), verification-first execution, and file-based state.`;
}

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
