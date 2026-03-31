import fs from 'fs';
import path from 'path';

/** Minimum character length for a raw prompt file to be considered valid. */
const MIN_PROMPT_LENGTH = 500;
/** Maximum character budget for the dynamically assembled system prompt. */
const PROMPT_CHAR_BUDGET = 25000;

const BASE = path.resolve(
    process.env.AGENT_PROMPT_PATH ?? path.join(process.cwd(), '../../external/agent-prompt'),
);
const RAW = path.join(BASE, 'system-prompt-raw.md');
const README = path.join(BASE, 'README.md');
const JSON_PROMPT = path.join(BASE, 'prompt.json');

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

function loadPromptData(): PromptData | null {
    if (cachedPromptData) return cachedPromptData;
    if (!fs.existsSync(JSON_PROMPT)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(JSON_PROMPT, 'utf-8'));
        cachedPromptData = data as PromptData;
        return cachedPromptData;
    } catch {
        return null;
    }
}

/**
 * Intelligent interpolation pipeline for subprompt selection.
 * Scores sections based on keyword density in context and assembles the prompt.
 */
export function getIntelligentSystemPrompt(context?: string): string {
    const data = loadPromptData();
    if (!data) return getFallbackPrompt();

    const introduction = data.introduction || "";
    if (!context) {
        // Return intro + level 1 (most critical) sections if no context
        const critical = data.sections
            .filter(s => s.level === 1)
            .map(s => `\n\n## ${s.title}\n\n${s.content}`)
            .join("");
        return `${introduction}${critical}`;
    }

    // Tokenize context
    const tokens = new Set(context.toLowerCase().split(/\W+/).filter(t => t.length > 3));
    
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

        return { ...section, score };
    });

    // Sort by score (descending) and filter relevant
    const relevant = scoredSections
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

    // Assemble within budget
    let assembled = introduction;
    let currentSize = assembled.length;

    for (const section of relevant) {
        const block = `\n\n## ${section.title}\n\n${section.content}`;
        if (currentSize + block.length < PROMPT_CHAR_BUDGET) {
            assembled += block;
            currentSize += block.length;
        }
    }

    return assembled;
}

function getFallbackPrompt(): string {
    // Tier 2: Raw Markdown File
    if (fs.existsSync(RAW)) {
        const data = fs.readFileSync(RAW, 'utf-8').trim();
        if (data.length > MIN_PROMPT_LENGTH) return data;
    }

    // Tier 3: Resilient README Extraction fallback
    if (fs.existsSync(README)) {
        const txt = fs.readFileSync(README, 'utf-8');
        const extracted = extractFromMarkdown(txt, "You are the principal architect and builder");
        if (extracted && extracted.length > MIN_PROMPT_LENGTH) return extracted;
    }

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

export function getMostCapableAgentSystemPrompt(): string {
    return getIntelligentSystemPrompt();
}

export const MOST_CAPABLE_AGENT_SYSTEM_PROMPT = getIntelligentSystemPrompt();
