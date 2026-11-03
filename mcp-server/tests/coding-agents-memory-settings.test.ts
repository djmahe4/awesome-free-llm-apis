import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { loadCodingAgentsSettings } from '../src/tools/coding-agents/settings.js';

describe('CodingAgentsSettings subagentValidation', () => {
    let ws = '';

    beforeEach(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-subagent-settings-'));
    });

    afterEach(async () => {
        if (ws) {
            await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    it('defaults to false when settings file is absent or malformed', async () => {
        expect(loadCodingAgentsSettings(ws).subagentValidation).toBe(false);

        await fs.outputFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), '{ not json');
        expect(loadCodingAgentsSettings(ws).subagentValidation).toBe(false);

        await fs.outputFile(path.join(ws, '.free-llm-mcp/coding-agents.json'), JSON.stringify({}));
        expect(loadCodingAgentsSettings(ws).subagentValidation).toBe(false);
    });

    it('can be enabled via .free-llm-mcp/coding-agents.json', async () => {
        await fs.outputFile(
            path.join(ws, '.free-llm-mcp/coding-agents.json'),
            JSON.stringify({ subagentValidation: true }),
        );
        expect(loadCodingAgentsSettings(ws).subagentValidation).toBe(true);

        await fs.outputFile(
            path.join(ws, '.free-llm-mcp/coding-agents.json'),
            JSON.stringify({ subagentValidation: false }),
        );
        expect(loadCodingAgentsSettings(ws).subagentValidation).toBe(false);
    });
});
