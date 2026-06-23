import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from '../utils/config-path.js';
import { useFreeLLM } from './use-free-llm.js';
import { memoryManager } from '../memory/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { getIntelligentSystemPrompt } from '../middleware/agentic/prompts.js';
import { ContextGatherer } from '../middleware/agentic/context-gatherer.js';

export interface StoreWorkspaceSkillInput {
    name: string;
    description: string;
    what: string[];
    why?: string;
    files?: string[];
    example?: string;
    script_instructions?: Record<string, string>;
    workspace_root: string;
}

export type StoreWorkspaceSkillResponse = 
    | { success: true; message: string; path: string; scripts: string[] }
    | { success: false; error: string };

const SKILL_SCRIPT_START = '@@@SKILL_SCRIPT_START@@@';
const SKILL_SCRIPT_END = '@@@SKILL_SCRIPT_END@@@';

export function normalizeScriptFilename(filename: string): string {
    const base = path.basename(filename.trim());
    if (base.endsWith('_py')) {
        return `${base.slice(0, -3)}.py`;
    }
    if (!path.extname(base)) {
        return base;
    }
    return base;
}

export function addScriptMetadataHeader(content: string, skillName: string, version: string, filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const commentPrefix = ['.py', '.sh', '.yaml', '.yml', '.toml'].includes(ext) ? '#' : '//';
    const timestamp = new Date().toISOString();
    const header = [
        `${commentPrefix} skill: ${skillName}`,
        `${commentPrefix} version: ${version}`,
        `${commentPrefix} generated_at: ${timestamp}`,
        ''
    ].join('\n');
    return `${header}${content}`;
}

/**
 * store_workspace_skill: Explicitly harvests structured knowledge into the workspace.
 * Follows the @skill-writer schema and Agent Skills specification.
 * v1.0.8: Now uses an internal LLM call to intelligently generate scripts based on instructions.
 */
export async function storeWorkspaceSkill(input: StoreWorkspaceSkillInput): Promise<StoreWorkspaceSkillResponse> {
    const { 
        name, 
        description, 
        what, 
        why, 
        files, 
        example, 
        script_instructions, 
        workspace_root 
    } = input;

    // Sanitize name for filesystem
    const skillSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const configDir = resolveConfigDir(workspace_root);
    const skillDir = path.join(configDir, 'skills', skillSlug);
    const scriptsDir = path.join(skillDir, 'scripts');

    const generatedScripts: Record<string, string> = {};

    // 0. Pre-fetch Workspace Context for the intelligent generation cycle
    const workspaceScanner = new WorkspaceScanner(workspace_root);
    let wsHash: string | undefined;
    try {
        wsHash = await workspaceScanner.getWorkspaceHash(workspace_root);
    } catch (err) {
        console.error(`[store_workspace_skill] Failed to hash workspace for memory lookup: ${err}`);
    }

    try {
        if (!fssync.existsSync(scriptsDir)) {
            await fs.mkdir(scriptsDir, { recursive: true });
        }

        // 1. Generate scripts via internal LLM if instructions are provided
        if (script_instructions) {
            for (const [filename, instruction] of Object.entries(script_instructions)) {
                try {
                    console.error(`[store_workspace_skill] Generating script '${filename}'...`);

                    // 1a. Fetch relevant context (Memory + Workspace Scan)
                    let memoryContext: string | undefined;
                    let grepContext: string[] = [];
                    
                    if (wsHash) {
                        // Vector Memory search
                        const memoryResults = await memoryManager.search(wsHash, instruction);
                        if (Array.isArray(memoryResults) && memoryResults.length > 0) {
                            memoryContext = (memoryResults as any[])
                                .slice(0, 3)
                                .map((m: any) => `- ${m.content || JSON.stringify(m)}`)
                                .join('\n');
                        }

                        // Real-time Workspace Scan (grep/rg)
                        grepContext = await ContextGatherer.gatherContext({
                            workspaceRoot: workspace_root,
                            query: instruction
                        });
                    }

                    // 1b. Build an intelligent system prompt
                    const baseSystemPrompt = await getIntelligentSystemPrompt({
                        context: instruction,
                        keywords: [],
                        memory: memoryContext,
                        isSubtask: false
                    });
                    
                    // Inject Grep Context manually into the prompt for grounding
                    const grepContextStr = grepContext.length > 0 
                        ? `\n\n## 🔍 WORKSPACE CONTEXT\nRelevant code snippets found in workspace:\n${grepContext.join('\n')}\n`
                        : '';

                    const systemPrompt = `${baseSystemPrompt}${grepContextStr}\n\n## 🛠️ TASK: SCRIPT GENERATION\nYou are generating a script named '${filename}' for the current workspace. 
Use the workspace memory and context snippets provided above to ensure the script follows established patterns and correctly interfaces with existing modules.
Output ONLY script content between delimiters:
${SKILL_SCRIPT_START}
# code here
${SKILL_SCRIPT_END}
No explanation.`;

                    const response = await useFreeLLM({
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { 
                                role: 'user', 
                                content: `Instruction for '${filename}': ${instruction}` 
                            }
                        ],
                        agentic: false, // Maintain non-agentic to avoid recursive reasoning loops
                        workspace_root
                    });

                    const raw = response.choices[0].message.content || '';
                    const delimitedMatch = raw.match(new RegExp(`${SKILL_SCRIPT_START}\\s*([\\s\\S]*?)\\s*${SKILL_SCRIPT_END}`));
                    const fencedMatch = raw.match(/```[\w-]*\n([\s\S]*?)```/);
                    const content = (delimitedMatch?.[1] || fencedMatch?.[1] || raw).trim();

                    if (content) {
                        const normalizedFilename = normalizeScriptFilename(filename);
                        const scriptPath = path.join(scriptsDir, path.basename(normalizedFilename));
                        const withMetadata = addScriptMetadataHeader(content, skillSlug, '1.0.6', normalizedFilename);
                        await fs.writeFile(scriptPath, withMetadata, 'utf-8');
                        generatedScripts[normalizedFilename] = withMetadata;

                        // Make shell scripts executable
                        if (normalizedFilename.endsWith('.sh')) {
                            await fs.chmod(scriptPath, 0o755);
                        }
                    }
                } catch (err: any) {
                    console.error(`[store_workspace_skill] Failed to generate script ${filename}:`, err.message);
                }
            }
        }

        // 2. Generate SKILL.md following @skill-writer schema
        const skillMd = [
            `---`,
            `name: ${skillSlug}`,
            `description: ${description}`,
            `risk: local`,
            `source: agent-led-harvesting`,
            `---`,
            ``,
            `# ${name}`,
            ``,
            `## Summary`,
            what.map(item => `- ${item}`).join('\n'),
            ``,
            why ? `## Rationale\n${why}\n` : '',
            files && files.length > 0 ? `## Files Involved\n${files.map(f => `- \`${f}\``).join('\n')}\n` : '',
            example ? `## Example\n${example}\n` : '',
            Object.keys(generatedScripts).length > 0 
                ? `## Scripts\n${Object.keys(generatedScripts).map(s => `- [${s}](./scripts/${s})`).join('\n')}\n` 
                : '',
            ``,
            `## Context`,
            `**Date:** ${new Date().toISOString()}`,
        ].join('\n');

        await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

        return {
            success: true,
            message: `Successfully stored skill '${skillSlug}' with ${Object.keys(generatedScripts).length} generated scripts in ${skillDir}`,
            path: skillDir,
            scripts: Object.keys(generatedScripts)
        };
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to store skill: ${err.message}`
        };
    }
}
