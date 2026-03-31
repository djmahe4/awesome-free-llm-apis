import fs from 'fs';
import path from 'path';

/** Minimum character length for a raw prompt file to be considered valid. */
const MIN_PROMPT_LENGTH = 500;

const BASE = path.resolve(
    process.env.AGENT_PROMPT_PATH ?? path.join(process.cwd(), '../../external/agent-prompt'),
);
const RAW = path.join(BASE, 'system-prompt-raw.md');
const README = path.join(BASE, 'README.md');

export function getMostCapableAgentSystemPrompt(): string {
    if (fs.existsSync(RAW)) {
        const data = fs.readFileSync(RAW, 'utf-8').trim();
        if (data.length > MIN_PROMPT_LENGTH) return data;
    }

    if (fs.existsSync(README)) {
        const txt = fs.readFileSync(README, 'utf-8');
        const start = txt.indexOf('You are the principal architect and builder');
        if (start !== -1) {
            const endMarkers = [
                'RESEARCH-INFORMED SYSTEMS TO STUDY',
                'OPEN-SOURCE SUPPORTING INFRASTRUCTURE',
            ];
            let end = txt.length;
            for (const m of endMarkers) {
                const i = txt.indexOf(m, start);
                if (i !== -1 && i < end) end = i;
            }
            return txt.slice(start, end).trim();
        }
    }

    return `You are the principal architect of a self-improving agent system.
Use queues (now, next, blocked, improve), verification-first execution, and file-based state.`;
}

export const MOST_CAPABLE_AGENT_SYSTEM_PROMPT = getMostCapableAgentSystemPrompt();
