import { BoundedMap } from '../utils/bounded-map.js';
import { lookupDnsRecords } from '../utils/dns-report.js';
import { CyberToolsRegistry, type CyberToolsRegistryCategory } from '../utils/CyberToolsRegistry.js';
import { GlobalWikiManager } from '../utils/GlobalWikiManager.js';
import { WikiMemory } from '../memory/wiki.js';
import { RepositoryGraph } from '../memory/dependency-scanner.js';
import { logToolCall } from '../utils/ChatLogger.js';
import { TaskType } from '../pipeline/middleware.js';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { RunRegistry } from '../pipeline/middlewares/RunRegistry.js';
import { runProjectBridge } from './project-bridge.js';

// Background osint autoSearch results, keyed the same way as its RunRegistry
// entry. Search-provider calls are network-bound and can legitimately run long,
// so the dork loop executes off the request/response path (see 'osint' action
// below) instead of blocking the tool call — callers poll with action:'osint_status'
// using the same sessionId+target, mirroring use_free_llm's run/continue/status pattern.
// Bounded: every autoSearch run kept its full results for the life of the server.
export const osintResultsCache = new BoundedMap<string, any[]>(100);

/** A tool name that is safe to use as a registry key and wiki page segment. */
export function isValidToolName(name: unknown): boolean {
    return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name);
}

/** sliceSize must be an integer in 1..50: 0 used to loop forever and a negative slice from the end. */
export function clampSliceSize(value: unknown): number {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
    return Math.min(50, Math.max(1, Math.floor(n)));
}

export interface CyberToolInput {
    action: 'list_tools' | 'get_tool' | 'register_tool' | 'wiki_lookup'
    | 'learn' | 'coach' | 'save_graph' | 'load_graph' | 'tool_memory' | 'osint' | 'osint_status'
    | 'run_action' | 'resolve_tool';
    toolName?: string;
    // resolve_tool
    /** Free-text question; the tool is matched against ALL registry tools by name/alias. */
    prompt?: string;
    /** Where to look; carried forward within a sessionId once chosen. */
    source?: 'github' | 'apt' | 'docker';
    /** Reply to the pending follow-up question (tool name, source, or option label). */
    choice?: string;
    githubUrl?: string;
    url?: string;
    urlType?: 'github' | 'apt' | 'docker' | 'generic';
    category?: 'security' | 'testing' | 'other';
    sessionId?: string;
    // osint
    target?: string;
    osintType?: 'domain' | 'ip' | 'username' | 'all';
    autoSearch?: boolean;
    allowPrivateIps?: boolean;
    // learn / coach
    goal?: string;
    level?: 'beginner' | 'intermediate' | 'advanced';
    observation?: string;
    // save_graph
    graphNode?: {
        id: string;
        label: string;
        type?: 'goal' | 'hypothesis' | 'action' | 'finding' | 'deadend';
        from?: string;
    };
    // tool_memory
    memoryOp?: 'read' | 'write';
    note?: string;

    // T8 run_action — project bridge dispatch (see project-bridge.ts)
    /** Bridge name from `<workspaceRoot>/.free-llm-mcp/bridges.json`; optional only when exactly one bridge is declared. */
    bridge?: string;
    /** Project folder holding `.free-llm-mcp/bridges.json` (default: process.cwd()) — lets one server serve multiple project roots. */
    workspaceRoot?: string;
    /** The bridge's own action name (dispatch vocabulary), e.g. a katana allowlisted action. */
    actionName?: string;
    /** Required authorization framing — only pass targets you are explicitly authorized to test. */
    authorization?: 'ctf' | 'lab' | 'consent';
    /** Action-specific arguments forwarded verbatim to the bridge (validated bridge-side). */
    args?: Record<string, unknown>;

    // DAG reverse-engineering extensions
    mode?: 'teach' | 'dag_reverse';
    repoPath?: string;
    nodeId?: string;
    statusOnly?: boolean;
    sliceSize?: number;

    // New: workspace dependency scan
    /** If true, scan the workspace root for dependency information (imports, commands, snippets) */
    scanWorkspace?: boolean;
}

export interface DagNode {
    id: string;
    sliceKey: string;
    status: 'pending' | 'done' | 'error';
    itemCount: number;
    items: any[];
    wikiPage?: string;
    error?: string;
}

export interface DagManifest {
    sessionId: string;
    toolName: string;
    repoPath: string;
    createdAt: string;
    totalNodes: number;
    nodes: DagNode[];
    cursor: number;
    completedNodes: number;
    wikiPagesWritten: string[];
}

const CYBER_WIKI_NAMESPACE = 'cyber-tools';

const FAILURE_LANGUAGE = /\b(didn't work|did not work|failed to|failure|error occurred|unsuccessful|not working|dead end)\b/i;

/**
 * Educational-coach system prompt shared by 'learn' and 'coach'. The model must teach, never claim
 * to execute, and must refuse targets that are clearly not authorized (no CTF/lab/consent framing).
 */
const COACH_SYSTEM_PROMPT = `You are a hands-on cybersecurity tutor for authorized security testing, CTF challenges, and lab environments ONLY.
You never execute commands yourself — you teach the learner exactly what to run and why, then they run it and report back.
For every step give: (1) the exact command, (2) a plain-English explanation of each flag/argument, (3) what output to expect, (4) how to interpret that output, (5) a safety/authorization note.
If the target or goal is not clearly an authorized test, CTF, or lab exercise, refuse and explain why.
Never claim you ran a command or observed real output — you only ever propose the next command for the human to run.`;

async function callCoachLLM(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, sessionId: string, toolContext?: { registeredTools: Array<{ name: string; category: CyberToolsRegistryCategory; githubUrl: string }>; dependencyCommands: Array<{ file: string; command: string }>; invokedTools: string[] }): Promise<string> {
    const { useFreeLLM } = await import('./use-free-llm.js');
    const result = await useFreeLLM({
        messages,
        taskType: TaskType.Cyber,
        sessionId,
        isOnePass: true
    } as any);
    const choices: Array<{ message?: { content?: string }; text?: string }> = Array.isArray((result as any)?.choices) ? (result as any).choices : [];
    const text = choices.map(c => (c?.message?.content ?? c?.text ?? '').trim()).filter(Boolean).join('\n\n');
    return text;
}

function graphPageTitle(sessionId: string): string {
    return `ctf-graph/${sessionId}`;
}

function progressPageTitle(sessionId: string): string {
    return `progress/${sessionId}`;
}

interface ProgressRecord {
    goal: string;
    level: string;
    plan: string;
    completedSteps: Array<{ observation?: string; advice: string; at: string }>;
    /** Total steps taken so far — kept separate from completedSteps.length since that array is windowed for storage. */
    stepCount: number;
    createdAt: string;
}

async function loadGraph(wiki: WikiMemory, sessionId: string): Promise<RepositoryGraph> {
    const page = await wiki.read(graphPageTitle(sessionId));
    if (!page) return new RepositoryGraph(CYBER_WIKI_NAMESPACE);
    try {
        const data = JSON.parse(page.content);
        return RepositoryGraph.deserialize(CYBER_WIKI_NAMESPACE, data);
    } catch {
        return new RepositoryGraph(CYBER_WIKI_NAMESPACE);
    }
}

async function persistGraph(wiki: WikiMemory, sessionId: string, graph: RepositoryGraph) {
    const serialized = graph.serialize();
    const links = graph.getAllNodes().map(n => n.id);
    await wiki.write(graphPageTitle(sessionId), JSON.stringify(serialized), ['cyber', 'ctf'], links);
}

function renderGraph(graph: RepositoryGraph): string {
    const nodes = graph.getAllNodes();
    const edges = graph.getAllEdges();
    if (nodes.length === 0) return '(no decision graph yet)';
    const lines = nodes.map(n => `- [${n.metadata?.ctfType || n.type}] ${n.id}: ${n.metadata?.label || ''}`);
    const edgeLines = edges.map(e => `  ${e.source} -> ${e.target}`);
    return [...lines, ...edgeLines].join('\n');
}

// Wiki pages are hard-capped at wikiConfig.maxPageSizeBytes (8192 bytes). A CTF session's progress
// record grows on every 'coach' call (plan + a full observation/advice per step), so it's capped and
// windowed here to stay well under that ceiling regardless of how long the session runs.
const PLAN_STORAGE_CAP = 1500;
const STEP_TEXT_CAP = 400;
const MAX_STORED_STEPS = 6;
const TOOL_NOTE_CAP = 500;
const TOOL_MEMORY_MAX_BYTES = 6000;

function capText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n…[truncated for storage]` : text;
}

function boundedProgress(progress: ProgressRecord): ProgressRecord {
    return {
        ...progress,
        plan: capText(progress.plan, PLAN_STORAGE_CAP),
        completedSteps: progress.completedSteps.slice(-MAX_STORED_STEPS)
    };
}

/**
 * Never throws — the coach must keep responding even if a page can't be persisted this turn. A failure is
 * recorded in `failures` (one entry per page) so the action's answer can say persisted:false instead of a plain success.
 */
async function safeWikiWrite(failures: string[], wiki: WikiMemory, title: string, content: string, tags: string[], links: string[] = []): Promise<boolean> {
    try {
        await wiki.write(title, content, tags, links);
        return true;
    } catch (err) {
        console.error(`[cyber_tool] wiki write failed for "${title}":`, err);
        failures.push(`${title}: ${(err as Error)?.message || err}`);
        return false;
    }
}

/** persistGraph that records a failure the same way instead of failing the whole action. */
async function safePersistGraph(failures: string[], wiki: WikiMemory, sessionId: string, graph: RepositoryGraph): Promise<boolean> {
    try {
        await persistGraph(wiki, sessionId, graph);
        return true;
    } catch (err) {
        console.error('[cyber_tool] graph save failed:', err);
        failures.push(`${graphPageTitle(sessionId)}: ${(err as Error)?.message || err}`);
        return false;
    }
}

/** Keeps only the most recent entries (split on the '---' separator) so the page stays under the size cap. */
function trimToByteBudget(content: string, maxBytes: number): string {
    const entries = content.split('\n\n---\n');
    while (entries.length > 1 && Buffer.byteLength(entries.join('\n\n---\n'), 'utf-8') > maxBytes) {
        entries.shift();
    }
    let joined = entries.join('\n\n---\n');
    if (Buffer.byteLength(joined, 'utf-8') > maxBytes) {
        joined = joined.slice(-maxBytes);
    }
    return joined;
}

/**
 * run_action values end up in a bridge subprocess's argv/stdin: bound them before they get there. The
 * action name is the bridge's own vocabulary (plain identifier), the target a single line of reasonable length.
 */
export function runActionInputProblem(input: Pick<CyberToolInput, 'actionName' | 'target' | 'authorization'>): string | null {
    const { actionName, target, authorization } = input;
    if (actionName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(actionName)) {
        return "actionName must be 1-64 characters: letters, digits, . _ : - (the bridge's own action name).";
    }
    if (target !== undefined && (target.length > 2048 || /[\u0000-\u001f\u007f]/.test(target))) {
        return 'target must be a single line of at most 2048 characters.';
    }
    if (authorization !== undefined && authorization.length > 2000) {
        return 'authorization must be at most 2000 characters.';
    }
    return null;
}

export async function cyberTool(input: CyberToolInput) {
    const start = Date.now();
    const action = input.action || 'list_tools';
    const sessionId = input.sessionId || 'cyber_tools_session';
    let result: any;
    let isError = false;
    // wiki pages / graph saves that failed during this call (see safeWikiWrite)
    const failures: string[] = [];

    try {
        // toolName becomes a wiki page segment and frontmatter tag: reject anything that is not a plain name.
        if (input.toolName !== undefined && action !== 'resolve_tool' && !isValidToolName(input.toolName)) {
            throw new Error('toolName must be 1-64 letters, digits, . _ + - and start with a letter or digit.');
        }
        if (action === 'list_tools') {
            const tools = await CyberToolsRegistry.loadRegistry();
            result = {
                success: true,
                totalTools: Object.keys(tools).length,
                registryPath: CyberToolsRegistry.getRegistryFilePath(),
                tools
            };
        } else if (action === 'get_tool') {
            if (!input.toolName) throw new Error('toolName parameter required for get_tool action');
            const url = await CyberToolsRegistry.getToolGithubUrl(input.toolName);
            result = {
                success: !!url,
                toolName: input.toolName,
                githubUrl: url || null
            };
        } else if (action === 'register_tool') {
            const toolUrl = input.url || input.githubUrl;
            if (!input.toolName || !toolUrl) throw new Error('toolName and url required for register_tool');
            const urlType = input.urlType || (input.githubUrl ? 'github' : 'generic');
            const updated = await CyberToolsRegistry.registerTool(input.toolName, toolUrl, urlType, input.category);
            result = {
                success: true,
                registeredTool: input.toolName,
                url: toolUrl,
                urlType: urlType,
                category: input.category || 'other',
                registry: updated
            };
        } else if (action === 'wiki_lookup') {
            if (!input.toolName) throw new Error('toolName required for wiki_lookup action');
            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);
            const pagePath = input.toolName + '/flags_and_troubleshooting';
            let page = await wiki.read(pagePath);
            if (!page) {
                const defaultContent = '# ' + input.toolName + ' Flags & Troubleshooting\n\nDefault operational flags and guidance for ' + input.toolName + '.';
                await safeWikiWrite(failures, wiki, pagePath, defaultContent, ['cyber', 'tool-guide', input.toolName]);
                page = await wiki.read(pagePath);
            }
            result = {
                success: !!page,
                toolName: input.toolName,
                wikiPage: page || null
            };
        } else if (action === 'learn') {
            const level = input.level || 'beginner';
            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);

            if (input.mode === 'dag_reverse') {
                // Gather tool availability context for DAG reverse engineering
                const workspaceRoot = input.workspaceRoot || process.cwd();
                const { CyberToolsRegistry } = await import('../utils/CyberToolsRegistry.js');
                const registeredTools = await CyberToolsRegistry.getToolNames();
                const toolCategories = await CyberToolsRegistry.getToolCategories();

                // Build registered tools list with categories
                const toolsWithCategories: Array<{ name: string; category: CyberToolsRegistryCategory; githubUrl: string }> = [];
                for (const toolName of registeredTools) {
                    const githubUrl = await CyberToolsRegistry.getToolGithubUrl(toolName);
                    toolsWithCategories.push({
                        name: toolName,
                        category: toolCategories[toolName] || 'other',
                        githubUrl: githubUrl || ''
                    });
                }

                if (!input.repoPath) throw new Error('repoPath required for learn action in dag_reverse mode');
                if (!input.toolName) throw new Error('toolName required for learn action in dag_reverse mode');

                const SLICE_SIZE = clampSliceSize(input.sliceSize);
                const nodes: DagNode[] = [];

                if (input.toolName === 'cybersec-toolkit') {
                    let configPath = input.repoPath ? path.join(input.repoPath, 'tools_config.json') : '';
                    if (!configPath || !existsSync(configPath)) {
                        const candidates = [
                            path.resolve(process.cwd(), 'external/cyber-tools-index/tools_config.json'),
                            path.resolve(process.cwd(), 'tests/context/cybersec-toolkit/tools_config.json'),
                            path.resolve(process.cwd(), 'scratch/cybersec-toolkit/tools_config.json')
                        ];
                        for (const c of candidates) {
                            if (existsSync(c)) {
                                configPath = c;
                                break;
                            }
                        }
                    }
                    if (!configPath || !existsSync(configPath)) {
                        throw new Error(`tools_config.json not found for cybersec-toolkit in ${input.repoPath || 'default paths'}`);
                    }
                    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
                    const byCategory = new Map<string, any[]>();
                    for (const t of raw) {
                        const cat = t.module ?? 'other';
                        if (!byCategory.has(cat)) byCategory.set(cat, []);
                        byCategory.get(cat)!.push(t);
                    }
                    for (const [cat, tools] of byCategory.entries()) {
                        const slicedTools = tools.slice(0, SLICE_SIZE);
                        nodes.push({
                            id: `cybersec-toolkit/${cat}`,
                            sliceKey: cat,
                            status: 'pending',
                            itemCount: slicedTools.length,
                            items: slicedTools.map((t: any) => ({ name: t.name, method: t.method, url: t.url, module: t.module }))
                        });
                    }
                } else if (input.toolName === 'hexstrike-ai') {
                    const mcpPath = path.join(input.repoPath, 'hexstrike_mcp.py');
                    const content = await fs.readFile(mcpPath, 'utf-8');
                    const funcs = [...content.matchAll(/^\s*def ([a-zA-Z][a-zA-Z0-9_]*)\(/gm)]
                        .map(m => m[1]).filter(f => !f.startsWith('_') && f !== 'format');
                    for (let i = 0, n = 0; i < funcs.length; i += SLICE_SIZE, n++) {
                        const batch = funcs.slice(i, i + SLICE_SIZE);
                        nodes.push({
                            id: `hexstrike-ai/slice-${n}`,
                            sliceKey: `slice-${n}`,
                            status: 'pending',
                            itemCount: batch.length,
                            items: batch
                        });
                    }
                } else {
                    throw new Error(`dag_reverse mode unsupported for toolName "${input.toolName}"`);
                }

                const manifest: DagManifest = {
                    sessionId,
                    toolName: input.toolName,
                    repoPath: input.repoPath,
                    createdAt: new Date().toISOString(),
                    totalNodes: nodes.length,
                    nodes,
                    cursor: 0,
                    completedNodes: 0,
                    wikiPagesWritten: []
                };

                const manifestForStorage = {
                    ...manifest,
                    nodes: manifest.nodes.map(n => ({ id: n.id, sliceKey: n.sliceKey, status: n.status, itemCount: n.itemCount, wikiPage: n.wikiPage, error: n.error }))
                };
                const manifestKey = `dag_manifest/${sessionId}`;
                await safeWikiWrite(failures, wiki, manifestKey, JSON.stringify(manifestForStorage), ['cyber', 'dag', input.toolName]);

                const graph = await loadGraph(wiki, sessionId);
                graph.addNode('root', 'concept', { ctfType: 'goal', label: input.goal || `DAG Reverse ${input.toolName}` });
                await safePersistGraph(failures, wiki, sessionId, graph);

                result = {
                    success: true,
                    goal: input.goal || `DAG Reverse ${input.toolName}`,
                    totalNodes: nodes.length,
                    nextNodeId: nodes[0]?.id ?? null,
                    progressKey: manifestKey,
                    graphKey: graphPageTitle(sessionId)
                };
            } else {
                if (!input.goal) throw new Error('goal parameter required for learn action');

                // Gather tool availability and dependency context from workspace
                const workspaceRoot = input.workspaceRoot || process.cwd();
                const { CyberToolsRegistry } = await import('../utils/CyberToolsRegistry.js');
                const registeredTools = await CyberToolsRegistry.getToolNames();
                const toolCategories = await CyberToolsRegistry.getToolCategories();

                // Build registered tools list with categories
                const toolsWithCategories: Array<{ name: string; category: CyberToolsRegistryCategory; githubUrl: string }> = [];
                for (const toolName of registeredTools) {
                    const githubUrl = await CyberToolsRegistry.getToolGithubUrl(toolName);
                    toolsWithCategories.push({
                        name: toolName,
                        category: toolCategories[toolName] || 'other',
                        githubUrl: githubUrl || ''
                    });
                }

                // Scan workspace for actual tool usage (commands found in code)
                let dependencyCommands: Array<{ file: string; command: string }> = [];
                let invokedTools: string[] = [];
                try {
                    const { WorkspaceDependencyScanner } = await import('../memory/dependency-scanner.js');
                    const scanner = new WorkspaceDependencyScanner(workspaceRoot);
                    const graph = new RepositoryGraph(workspaceRoot);
                    await scanner.scanWorkspace(graph);

                    const codeNodes = graph.getAllNodes().filter(n => n.type === 'code');
                    for (const node of codeNodes) {
                        const metadata = node.metadata as any;
                        if (metadata?.commands) {
                            for (const cmd of metadata.commands) {
                                dependencyCommands.push({ file: node.id, command: cmd });
                            }
                        }
                    }
                    const invokes = graph.getAllEdges().filter(e => e.type === 'invokes');
                    const invokeSet = new Set<string>();
                    for (const edge of invokes) {
                        invokeSet.add(edge.target);
                    }
                    invokedTools = Array.from(invokeSet);
                } catch (e) {
                    // If dependency scan fails, continue with empty context
                    console.warn('[cyber_tool] Dependency scan failed:', e);
                }

                const walkthrough = await callCoachLLM([
                    { role: 'system', content: COACH_SYSTEM_PROMPT },
                    { role: 'user', content: `Learner level: ${level}.\nGoal: ${input.goal}\nGive a numbered, step-by-step walkthrough for this goal in an authorized/lab/CTF context.` }
                ], sessionId, {
                    registeredTools: toolsWithCategories,
                    dependencyCommands: dependencyCommands.length > 0 ? dependencyCommands.slice(0, 20) : [],
                    invokedTools: invokedTools.length > 0 ? invokedTools.slice(0, 20) : []
                });

                const progress: ProgressRecord = {
                    goal: input.goal,
                    level,
                    plan: walkthrough,
                    completedSteps: [],
                    stepCount: 0,
                    createdAt: new Date().toISOString()
                };
                await safeWikiWrite(failures, wiki, progressPageTitle(sessionId), JSON.stringify(boundedProgress(progress)), ['cyber', 'learn']);

                const graph = await loadGraph(wiki, sessionId);
                graph.addNode('root', 'concept', { ctfType: 'goal', label: input.goal });
                await safePersistGraph(failures, wiki, sessionId, graph);

                result = {
                    success: true,
                    goal: input.goal,
                    level,
                    walkthrough,
                    progressKey: progressPageTitle(sessionId),
                    graphKey: graphPageTitle(sessionId)
                };
            }
        } else if (action === 'coach') {
            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);

            // Re-fetch tool availability and dependency context for coach
            const workspaceRoot = input.workspaceRoot || process.cwd();
            const { CyberToolsRegistry } = await import('../utils/CyberToolsRegistry.js');
            const registeredTools = await CyberToolsRegistry.getToolNames();
            const toolCategories = await CyberToolsRegistry.getToolCategories();

            // Build registered tools list with categories
            const toolsWithCategories: Array<{ name: string; category: CyberToolsRegistryCategory; githubUrl: string }> = [];
            for (const toolName of registeredTools) {
                const githubUrl = await CyberToolsRegistry.getToolGithubUrl(toolName);
                toolsWithCategories.push({
                    name: toolName,
                    category: toolCategories[toolName] || 'other',
                    githubUrl: githubUrl || ''
                });
            }

            // Scan workspace for actual tool usage (commands found in code)
            let dependencyCommands: Array<{ file: string; command: string }> = [];
            let invokedTools: string[] = [];
            try {
                const { WorkspaceDependencyScanner } = await import('../memory/dependency-scanner.js');
                const scanner = new WorkspaceDependencyScanner(workspaceRoot);
                const graph = new RepositoryGraph(workspaceRoot);
                await scanner.scanWorkspace(graph);

                const codeNodes = graph.getAllNodes().filter(n => n.type === 'code');
                for (const node of codeNodes) {
                    const metadata = node.metadata as any;
                    if (metadata?.commands) {
                        for (const cmd of metadata.commands) {
                            dependencyCommands.push({ file: node.id, command: cmd });
                        }
                    }
                }
                const invokes = graph.getAllEdges().filter(e => e.type === 'invokes');
                const invokeSet = new Set<string>();
                for (const edge of invokes) {
                    invokeSet.add(edge.target);
                }
                invokedTools = Array.from(invokeSet);
            } catch (e) {
                // If dependency scan fails, continue with empty context
                console.warn('[cyber_tool] Dependency scan failed:', e);
            }

            if (input.mode === 'dag_reverse') {
                const manifestKey = `dag_manifest/${sessionId}`;
                const manifestPage = await wiki.read(manifestKey);
                if (!manifestPage) throw new Error(`dag_manifest not found for session "${sessionId}". Run learn action in dag_reverse mode first.`);

                const manifest: DagManifest = JSON.parse(manifestPage.content);

                if (input.statusOnly) {
                    const done = manifest.nodes.filter(n => n.status === 'done').length;
                    const pending = manifest.nodes.filter(n => n.status === 'pending').length;
                    const errors = manifest.nodes.filter(n => n.status === 'error').length;
                    const next = manifest.nodes.find(n => n.status === 'pending');
                    result = {
                        success: true,
                        sessionId,
                        toolName: manifest.toolName,
                        totalNodes: manifest.totalNodes,
                        done, pending, errors,
                        pctComplete: Math.round((done / manifest.totalNodes) * 100),
                        nextNodeId: next?.id ?? null,
                        wikiPagesWritten: manifest.wikiPagesWritten
                    };
                    return result;
                }

                let targetNode: DagNode | undefined;
                if (input.nodeId) {
                    targetNode = manifest.nodes.find(n => n.id === input.nodeId);
                    if (!targetNode) throw new Error(`nodeId "${input.nodeId}" not found in manifest`);
                } else {
                    targetNode = manifest.nodes.find(n => n.status === 'pending');
                }

                if (!targetNode) {
                    result = { success: true, message: 'All DAG nodes complete', totalNodes: manifest.totalNodes, completedNodes: manifest.completedNodes, pctComplete: 100 };
                    return result;
                }

                // Rehydrate items from source repo files on demand
                let items: any[] = [];
                if (manifest.toolName === 'cybersec-toolkit') {
                    const configPath = path.join(manifest.repoPath, 'tools_config.json');
                    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
                    const category = targetNode.sliceKey;
                    items = raw.filter((t: any) => (t.module ?? 'other') === category).slice(0, 50).map((t: any) => ({ name: t.name, method: t.method, url: t.url, module: t.module }));
                } else if (manifest.toolName === 'hexstrike-ai') {
                    const mcpPath = path.join(manifest.repoPath, 'hexstrike_mcp.py');
                    const content = await fs.readFile(mcpPath, 'utf-8');
                    const funcs = [...content.matchAll(/^\s*def ([a-zA-Z][a-zA-Z0-9_]*)\(/gm)]
                        .map(m => m[1]).filter(f => !f.startsWith('_') && f !== 'format');
                    const sliceIndex = parseInt(targetNode.sliceKey.replace('slice-', ''), 10) || 0;
                    items = funcs.slice(sliceIndex * 50, (sliceIndex + 1) * 50);
                }
                targetNode.items = items;

                const itemSummary = items.map((item: any) => {
                    if (typeof item === 'string') return `endpoint: ${item}`;
                    return `${item.name} [${item.method}] → ${item.url}`;
                }).join('\n');

                const observation = `Repository: ${manifest.toolName}\nNode: ${targetNode.id}\nItems (${targetNode.itemCount}):\n${itemSummary}`;

                let analysis = '';
                try {
                    analysis = await callCoachLLM([
                        { role: 'system', content: COACH_SYSTEM_PROMPT },
                        { role: 'user', content: `Reverse-engineer the following security tools and their setup mechanisms. For each, produce concise notes on: (1) install command, (2) typical usage, (3) security testing use-case.\n\n${observation}` }
                    ], sessionId, {
                        registeredTools: toolsWithCategories,
                        dependencyCommands: dependencyCommands.length > 0 ? dependencyCommands.slice(0, 20) : [],
                        invokedTools: invokedTools.length > 0 ? invokedTools.slice(0, 20) : []
                    });
                } catch (err: any) {
                    // No analysis, no page: writing "(LLM call unavailable ...)" and marking the node done made a
                    // failed node look finished and blocked its retry. It stays pending so the same call can be repeated.
                    targetNode.error = `model call failed: ${err?.message || err}`;
                    isError = true;
                    return result = { success: false, nodeId: targetNode.id, status: 'pending', error: `Could not analyse node ${targetNode.id}: ${err?.message || err}. It stays pending; call again to retry.` };
                }

                for (const item of targetNode.items) {
                    const name = typeof item === 'string' ? item : item.name;
                    const note = typeof item === 'string'
                        ? `MCP endpoint: ${item} | From: hexstrike-ai server`
                        : `Install: ${item.method} | URL: ${item.url} | Category: ${item.module} | Use: security testing`;
                    const existing = await wiki.read(`${name}/run_suggestions`);
                    const appended = trimToByteBudget(existing ? `${existing.content}\n\n---\n${note}` : note, TOOL_MEMORY_MAX_BYTES);
                    await safeWikiWrite(failures, wiki, `${name}/run_suggestions`, appended, ['cyber', manifest.toolName]);
                }

                const toolRows = targetNode.items.map((item: any) => {
                    if (typeof item === 'string') return `| \`${item}\` | hexstrike MCP endpoint | — |`;
                    return `| \`${item.name}\` | \`${item.method}\` | ${item.url} |`;
                });

                const wikiContent = [
                    `# ${manifest.toolName} — ${targetNode.sliceKey.toUpperCase()}`,
                    ``,
                    `> DAG-generated | Session: \`${sessionId}\` | Source: https://github.com/${manifest.toolName}`,
                    ``,
                    `## Overview`,
                    `**${targetNode.itemCount} items** in node \`${targetNode.id}\``,
                    ``,
                    `## Items`,
                    ``,
                    `| Item | Type/Method | Source |`,
                    `|:---|:---|:---|`,
                    ...toolRows,
                    ``,
                    `## Reverse-Engineering Notes`,
                    ``,
                    analysis
                ].join('\n');

                const pageSaved = await safeWikiWrite(failures, wiki, targetNode.id, wikiContent, ['cyber', 'dag', manifest.toolName]);
                if (!pageSaved) {
                    // the node's result has nowhere to live: it must not be marked done
                    isError = true;
                    return result = { success: false, nodeId: targetNode.id, status: 'pending', persisted: false, persistWarnings: [...failures], error: `Could not save the wiki page for node ${targetNode.id}. It stays pending; call again to retry.` };
                }

                const graph = await loadGraph(wiki, sessionId);
                graph.addNode(targetNode.id, 'concept', { ctfType: 'action', label: `Node ${targetNode.id}: ${targetNode.itemCount} items` });
                graph.addEdge('root', targetNode.id, 'references');
                await safePersistGraph(failures, wiki, sessionId, graph);

                targetNode.status = 'done';
                targetNode.wikiPage = targetNode.id;
                manifest.completedNodes += 1;
                manifest.cursor = manifest.nodes.findIndex(n => n.status === 'pending');
                if (!manifest.wikiPagesWritten.includes(targetNode.id)) manifest.wikiPagesWritten.push(targetNode.id);

                const manifestForStorage = {
                    ...manifest,
                    nodes: manifest.nodes.map(n => ({ id: n.id, sliceKey: n.sliceKey, status: n.status, itemCount: n.itemCount, wikiPage: n.wikiPage, error: n.error }))
                };
                await safeWikiWrite(failures, wiki, manifestKey, JSON.stringify(manifestForStorage), ['cyber', 'dag', manifest.toolName]);

                const nextPending = manifest.nodes.find(n => n.status === 'pending');
                result = {
                    success: true,
                    nodeId: targetNode.id,
                    status: 'done',
                    itemsProcessed: targetNode.itemCount,
                    wikiPageTitle: targetNode.id,
                    nextNodeId: nextPending?.id ?? null,
                    completedNodes: manifest.completedNodes,
                    totalNodes: manifest.totalNodes,
                    pctComplete: Math.round((manifest.completedNodes / manifest.totalNodes) * 100)
                };
            } else {
                const progressPage = await wiki.read(progressPageTitle(sessionId));
                const progress: ProgressRecord | null = progressPage ? JSON.parse(progressPage.content) : null;

                const graph = await loadGraph(wiki, sessionId);
                const graphContext = renderGraph(graph);

                let toolMemoryContext = '';
                if (input.toolName) {
                    const suggestions = await wiki.read(`${input.toolName}/run_suggestions`);
                    const troubleshooting = await wiki.read(`${input.toolName}/flags_and_troubleshooting`);
                    toolMemoryContext = [
                        suggestions ? `Prior run suggestions for ${input.toolName}:\n${suggestions.content}` : '',
                        troubleshooting ? `Known flags/troubleshooting for ${input.toolName}:\n${troubleshooting.content}` : ''
                    ].filter(Boolean).join('\n\n');
                }

                const contextBlock = [
                    progress ? `Original goal: ${progress.goal} (level: ${progress.level})\nPlan so far:\n${progress.plan}` : '(no saved plan for this session)',
                    `Decision graph so far:\n${graphContext}`,
                    toolMemoryContext
                ].filter(Boolean).join('\n\n---\n\n');

                const advice = await callCoachLLM([
                    { role: 'system', content: COACH_SYSTEM_PROMPT },
                    { role: 'user', content: `${contextBlock}\n\n---\n\nLearner's latest observation: ${input.observation || '(none provided)'}\n\nDiagnose what happened and give the single next command to run, with explanation, expected output, and safety note.` }
                ], sessionId, {
                    registeredTools: toolsWithCategories,
                    dependencyCommands: dependencyCommands.length > 0 ? dependencyCommands.slice(0, 20) : [],
                    invokedTools: invokedTools.length > 0 ? invokedTools.slice(0, 20) : []
                });

                const isFailure = FAILURE_LANGUAGE.test(input.observation || '');

                const baseProgress: ProgressRecord = progress || {
                    goal: input.goal || '(unspecified)',
                    level: input.level || 'beginner',
                    plan: '',
                    completedSteps: [],
                    stepCount: 0,
                    createdAt: new Date().toISOString()
                };
                const stepNumber = (Number.isFinite(baseProgress.stepCount) ? baseProgress.stepCount : baseProgress.completedSteps.length) + 1;
                const updatedProgress: ProgressRecord = {
                    ...baseProgress,
                    stepCount: stepNumber,
                    completedSteps: [
                        ...baseProgress.completedSteps,
                        { observation: input.observation ? capText(input.observation, STEP_TEXT_CAP) : undefined, advice: capText(advice, STEP_TEXT_CAP), at: new Date().toISOString() }
                    ]
                };
                await safeWikiWrite(failures, wiki, progressPageTitle(sessionId), JSON.stringify(boundedProgress(updatedProgress)), ['cyber', 'learn']);

                const stepId = `step-${stepNumber}`;
                const priorStepId = stepNumber > 1 ? `step-${stepNumber - 1}` : 'root';
                graph.addNode(stepId, 'concept', {
                    ctfType: isFailure ? 'deadend' : 'action',
                    label: input.observation ? `Observed: ${input.observation}` : advice.slice(0, 120)
                });
                graph.addEdge(priorStepId, stepId, 'references');
                await safePersistGraph(failures, wiki, sessionId, graph);

                if (input.toolName) {
                    const suggestionNote = advice.slice(0, TOOL_NOTE_CAP);
                    // Store structured pattern: install command, typical flags, use case
                    const structuredNote = `Install: ${suggestionNote}\nUse: security testing`;
                    const existing = await wiki.read(`${input.toolName}/run_suggestions`);
                    const appended = trimToByteBudget(existing ? `${existing.content}\n\n---\n${structuredNote}` : structuredNote, TOOL_MEMORY_MAX_BYTES);
                    await safeWikiWrite(failures, wiki, `${input.toolName}/run_suggestions`, appended, ['cyber']);
                    if (isFailure) {
                        GlobalWikiManager.logFailure(input.toolName);
                    } else {
                        GlobalWikiManager.logSuccess(input.toolName);
                    }
                    await GlobalWikiManager.flushToWiki(wiki);
                }

                result = {
                    success: true,
                    nextStep: advice,
                    notes: isFailure ? 'Observation looked like a failure — marked as a dead end in the decision graph.' : undefined,
                    progressKey: progressPageTitle(sessionId),
                    graphKey: graphPageTitle(sessionId)
                };
            }
        } else if (action === 'save_graph') {
            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);
            const graph = await loadGraph(wiki, sessionId);
            if (input.graphNode) {
                const { id, label, type, from } = input.graphNode;
                graph.addNode(id, 'concept', { ctfType: type || 'action', label });
                if (from) graph.addEdge(from, id, 'references');
            }
            await safePersistGraph(failures, wiki, sessionId, graph);
            result = {
                success: true,
                sessionId,
                graphKey: graphPageTitle(sessionId),
                totalNodes: graph.getAllNodes().length,
                totalEdges: graph.getAllEdges().length
            };
        } else if (action === 'load_graph') {
            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);
            const graph = await loadGraph(wiki, sessionId);
            result = {
                success: true,
                sessionId,
                nodes: graph.getAllNodes(),
                edges: graph.getAllEdges(),
                rendered: renderGraph(graph)
            };
        } else if (action === 'tool_memory') {
            if (!input.toolName) throw new Error('toolName required for tool_memory action');
            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);
            const memoryOp = input.memoryOp || 'read';
            if (memoryOp === 'write') {
                if (!input.note) throw new Error('note required for tool_memory write');
                // Store structured pattern: install command, typical flags, use case
                const structuredNote = `Install: ${capText(input.note, TOOL_NOTE_CAP)}\nUse: security testing`;
                const existing = await wiki.read(`${input.toolName}/run_suggestions`);
                const appended = trimToByteBudget(existing ? `${existing.content}\n\n---\n${structuredNote}` : structuredNote, TOOL_MEMORY_MAX_BYTES);
                const written = await safeWikiWrite(failures, wiki, `${input.toolName}/run_suggestions`, appended, ['cyber']);
                result = { success: written, toolName: input.toolName, wikiPage: written ? await wiki.read(`${input.toolName}/run_suggestions`) : null };
            } else {
                const suggestions = await wiki.read(`${input.toolName}/run_suggestions`);
                const troubleshooting = await wiki.read(`${input.toolName}/flags_and_troubleshooting`);
                const stats = GlobalWikiManager.getStats()[input.toolName];
                result = {
                    success: !!(suggestions || troubleshooting),
                    toolName: input.toolName,
                    runSuggestions: suggestions || null,
                    flagsAndTroubleshooting: troubleshooting || null,
                    reliability: stats || null
                };
            }
        } else if (action === 'osint') {
            const target = (input.target || '').trim();
            if (!target) throw new Error('target is required and cannot be empty for osint action');
            const osintType = input.osintType || 'all';

            // SSRF & target scope guard (shared with browser_tool): decimal/hex/octal IPs, CGNAT, every IPv6 private
            // range, ports, internal names and hostnames that RESOLVE to private addresses are refused. Cloud
            // metadata addresses are refused even with allowPrivateIps. A username target is not a host.
            if (osintType !== 'username') {
                const { checkHostTarget } = await import('../utils/ssrf-guard.js');
                const verdict = await checkHostTarget(target, { allowPrivate: !!input.allowPrivateIps });
                if (!verdict.ok) {
                    throw new Error(`Security error: invalid or private target rejected to prevent SSRF: ${target} (${verdict.code})`);
                }
            }

            const dns = await import('node:dns/promises');

            const dnsReport: Record<string, any> = {};
            const resolvedIps: string[] = [];

            const shouldQueryDns = osintType === 'domain' || osintType === 'ip' || osintType === 'all';

            if (shouldQueryDns) {
                // parallel, each bounded by its own (cleared) timer
                const looked = await lookupDnsRecords(target, dns as any, 3000);
                Object.assign(dnsReport, looked.report);
                resolvedIps.push(...looked.resolvedIps);
            }

            const recommendedDorks: string[] = [];
            if (osintType === 'username') {
                recommendedDorks.push(
                    `site:github.com "${target}"`,
                    `site:twitter.com "${target}" | site:x.com "${target}"`,
                    `site:linkedin.com/in/ "${target}"`,
                    `site:reddit.com/user/ "${target}"`
                );
            } else {
                recommendedDorks.push(
                    `site:${target} filetype:pdf`,
                    `site:${target} inurl:admin | inurl:login`,
                    `site:github.com "${target}"`,
                    `site:linkedin.com/in/ "${target}"`,
                    `site:crt.sh/?q=${target}`
                );
            }

            // Multi-step Automated Reconnaissance: execute dorks via SearchProviderRegistry if requested.
            // Runs detached in the background (RunRegistry-tracked, same pattern as use_free_llm's
            // run/continue/status) instead of blocking this call — a hung search provider used to be
            // able to stall the whole osint request with no way to poll or recover.
            const osintRunKey = `osint:${sessionId}:${target}`;
            let searchResults: any[] = [];
            let searchStatus: 'idle' | 'running' | 'done' = 'idle';
            if (input.autoSearch) {
                const existing = RunRegistry.get(osintRunKey);
                if (existing && !existing.done) {
                    searchStatus = 'running';
                } else if (existing && existing.done) {
                    searchResults = osintResultsCache.get(osintRunKey) || [];
                    searchStatus = 'done';
                } else {
                    const run = RunRegistry.start(osintRunKey);
                    searchStatus = 'running';
                    const topDorks = recommendedDorks.slice(0, 3);
                    (async () => {
                        const results: any[] = [];
                        try {
                            const { SearchProviderRegistry } = await import('../search/registry.js');
                            const searchRegistry = SearchProviderRegistry.getInstance();
                            const available = searchRegistry.getAvailableProviders();
                            const provider = available[0] || searchRegistry.getProviders()[0];
                            if (provider) {
                                for (let i = 0; i < topDorks.length; i++) {
                                    if (run.controller.signal.aborted) break;
                                    const dork = topDorks[i];
                                    try {
                                        // Bound each provider call — background execution still needs a
                                        // ceiling per call, otherwise one hung request leaks the run forever.
                                        const res = await Promise.race([
                                            provider.search(dork, 3),
                                            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('search provider timeout')), 15_000)),
                                        ]);
                                        results.push({ query: dork, results: Array.isArray(res) ? res : [] });
                                    } catch (e: any) {
                                        results.push({ query: dork, error: String(e?.message || e), results: [] });
                                    }
                                    RunRegistry.progress(osintRunKey, dork, i + 1, topDorks.length);
                                }
                            }
                        } catch (e: any) {
                            RunRegistry.finish(osintRunKey, String(e?.message || e));
                            osintResultsCache.set(osintRunKey, results);
                            return;
                        }
                        osintResultsCache.set(osintRunKey, results);
                        RunRegistry.finish(osintRunKey);
                    })();
                }
            }

            // Build high-level summary
            const summaryParts: string[] = [];
            if (shouldQueryDns) {
                summaryParts.push(`Resolved ${resolvedIps.length} IP(s)`);
                if (dnsReport.MX?.length) summaryParts.push(`${dnsReport.MX.length} Mail Server(s)`);
                if (dnsReport.TXT?.length) summaryParts.push(`${dnsReport.TXT.length} TXT/SPF Record(s)`);
                if (dnsReport.NS?.length) summaryParts.push(`${dnsReport.NS.length} Nameserver(s)`);
            } else {
                summaryParts.push(`Target type: ${osintType}`);
            }
            summaryParts.push(`${recommendedDorks.length} Recon Dorks formulated`);
            if (input.autoSearch) {
                summaryParts.push(searchStatus === 'done'
                    ? `${searchResults.reduce((acc, s) => acc + (s.results?.length || 0), 0)} search result(s) gathered`
                    : 'search running in background — poll with action:"osint_status"');
            }
            const summary = summaryParts.join(' | ');

            const wiki = new WikiMemory(CYBER_WIKI_NAMESPACE);
            const wikiContent = `# OSINT Report for ${target}\n\n`
                + `**Timestamp**: ${new Date().toISOString()}\n\n`
                + `**Summary**: ${summary}\n\n`
                + `## Resolved IPs\n${resolvedIps.map(ip => `- ${ip}`).join('\n') || '- None'}\n\n`
                + `## DNS Records\n\`\`\`json\n${JSON.stringify(dnsReport, null, 2)}\n\`\`\`\n\n`
                + `## Recommended Google / Recon Dorks\n${recommendedDorks.map(d => `- \`${d}\``).join('\n')}\n\n`
                + (input.autoSearch && searchStatus === 'done' ? `## Automated Search Results\n\`\`\`json\n${JSON.stringify(searchResults, null, 2)}\n\`\`\`\n` : '');

            await safeWikiWrite(failures, wiki, `osint/${target.replace(/[^\w.-]/g, '_')}`, wikiContent, ['cyber', 'osint']);

            result = {
                success: true,
                target,
                osintType,
                resolvedIps,
                dns: dnsReport,
                recommendedDorks,
                summary,
                ...(input.autoSearch ? {
                    searchStatus,
                    ...(searchStatus === 'done' ? { searchResults } : { sessionId, pollAction: 'osint_status' }),
                } : {}),
                timestamp: new Date().toISOString()
            };
        } else if (action === 'osint_status') {
            const target = (input.target || '').trim();
            if (!target) throw new Error('target is required for osint_status');
            const osintRunKey = `osint:${sessionId}:${target}`;
            const run = RunRegistry.get(osintRunKey);
            if (!run) {
                result = { success: false, searchStatus: 'idle', message: 'No osint autoSearch run found for this sessionId+target. Call action:"osint" with autoSearch:true first.' };
            } else if (!run.done) {
                result = {
                    success: true,
                    searchStatus: 'running',
                    progress: { completed: run.completedCount, total: run.totalCount, lastQuery: run.lastSubtask },
                };
            } else {
                result = {
                    success: !run.error,
                    searchStatus: 'done',
                    error: run.error,
                    searchResults: osintResultsCache.get(osintRunKey) || [],
                };
            }
        } else if (action === 'resolve_tool') {
            const { resolveTool } = await import('./resolve-tool.js');
            // the raw sessionId: without one, resolve_tool gives the caller a private session instead of the shared default
            result = await resolveTool({ prompt: input.prompt, toolName: input.toolName, source: input.source, choice: input.choice, sessionId: input.sessionId });
        } else if (action === 'run_action') {
            // T8 — dispatch through a project-declared bridge subprocess
            // (general mechanism: any project's `.free-llm-mcp/bridges.json`,
            // any server, multiple project roots per MCP server). Every
            // failure below returns success:false instead of throwing so the
            // caller always gets a structured result.
            // A failure answers success:false AND is logged as an error (it used to be logged as a normal call).
            const rejectRunAction = (error: string) => { isError = true; result = { success: false, action, error }; };
            const inputProblem = runActionInputProblem(input);
            if (!input.authorization) {
                rejectRunAction('run_action requires authorization framing — only pass targets you are explicitly authorized to test');
            } else if (!input.actionName || !input.target) {
                rejectRunAction('run_action requires actionName and target');
            } else if (inputProblem) {
                rejectRunAction(inputProblem);
            } else {
                try {
                    const { bridge, finding } = await runProjectBridge({
                        workspaceRoot: input.workspaceRoot || process.cwd(),
                        bridge: input.bridge,
                        actionName: input.actionName,
                        target: input.target,
                        args: input.args,
                        authorization: input.authorization,
                    });
                    result = {
                        success: true,
                        action,
                        bridge,
                        actionName: input.actionName,
                        target: input.target,
                        finding,
                    };
                } catch (err: any) {
                    rejectRunAction(String(err?.message || err));
                }
            }
        } else {
            throw new Error(`Unsupported cyber_tool action: ${action}`);
        }
        // Anything that could not be saved is part of the answer (it used to be swallowed behind success:true)
        if (failures.length > 0 && result && typeof result === 'object' && !Array.isArray(result)) {
            result.persisted = false;
            result.persistWarnings = [...failures];
        }
    } catch (err: any) {
        isError = true;
        result = { error: String(err?.message || err) };
        throw err;
    } finally {
        // Phase 3 Chat Logger Integration — Log each action step into chat-logs.json
        await logToolCall(sessionId, `cyber_tool:${action}`, input, result, Date.now() - start, isError).catch(() => { });
    }

    return result;
}
