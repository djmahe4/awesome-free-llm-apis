import { memoryManager } from '../memory/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { ContextManager } from '../utils/ContextManager.js';
import { quantumCompressWithAnchors } from '../utils/quantum-compression.js';
import type { ProductivityMemory } from '../memory/productivity.js';

/**
 * Classifies a new task's urgency/importance for the Eisenhower matrix.
 * Rather than judging the task in isolation, the prompt gives the model a
 * table of the workspace's existing open tasks (so a new task is placed
 * relative to real, already-classified peers instead of an ungrounded
 * absolute judgment) plus a handful of worked examples that explain the
 * urgent/important DISTINCTION through reasoning, not just by naming the
 * fields — "urgent" means time-sensitive/has a deadline pressure, distinct
 * from "important" meaning it matters to real goals; the classic trap is
 * conflating "someone is asking for it now" (urgent-feeling) with "it
 * actually matters" (important) — plain field names invite that conflation,
 * few-shot reasoning heads it off.
 */
async function classifyEisenhowerTask(
    task: string,
    productivity: ProductivityMemory
): Promise<{ urgent: boolean; important: boolean }> {
    const existing = await productivity.listTasks(undefined, false);
    const taskTable = existing.length > 0
        ? [
            '| Task | Urgent | Important | Quadrant |',
            '|---|---|---|---|',
            ...existing.slice(0, 20).map(t => `| ${t.task.replace(/\|/g, '/')} | ${t.urgent} | ${t.important} | ${t.quadrant} |`),
        ].join('\n')
        : '(no existing tasks yet in this workspace)';

    const prompt = [
        'You are classifying a task into the Eisenhower matrix: urgent (time-pressured — a deadline or someone waiting on it right now) and important (moves a real goal forward, regardless of deadline pressure). These are independent axes — a task can be urgent without being important, or important without being urgent. The common mistake is treating "urgent-feeling" (loud, immediate, someone asking) as the same thing as "important" (actually matters); judge each axis separately.',
        '## Worked examples',
        '- Task: "Production database is down, customers can\'t log in" → urgent: true, important: true. Reasoning: active outage, time-critical AND directly affects the core goal (keeping the product working).',
        '- Task: "Reply to a Slack message asking for a status update by end of day" → urgent: true, important: false. Reasoning: has a deadline pressure, but answering it doesn\'t itself move any real goal forward — it\'s reactive, not generative.',
        '- Task: "Read a book on system design to improve architecture skills" → urgent: false, important: true. Reasoning: no deadline, but it compounds toward a real long-term capability goal.',
        '- Task: "Reorganize the file: subfolder naming for cosmetic consistency" → urgent: false, important: false. Reasoning: no deadline, and doesn\'t meaningfully advance any goal.',
        '## Existing tasks in this workspace (for context — place the new task relative to these, not in isolation)',
        taskTable,
        `## Task to classify\n"${task}"`,
        'Reply with ONLY a JSON object: {"urgent": boolean, "important": boolean}. No other text, no explanation in the reply itself.',
    ].join('\n\n');

    const { useFreeLLM } = await import('./use-free-llm.js');
    const res = await useFreeLLM({
        messages: [
            { role: 'system', content: 'You are a precise task-classification assistant. Reply with ONLY the requested JSON object.' },
            { role: 'user', content: prompt },
        ],
        isOnePass: true,
        skipIndexing: true,
    });
    const raw = res?.choices?.[0]?.message?.content || (res as any)?.content || (typeof res === 'string' ? res : '');
    const match = String(raw).match(/\{[^{}]*\}/);
    if (!match) throw new Error(`autoClassify failed: LLM response had no parseable JSON object ("${String(raw).slice(0, 200)}").`);
    let parsed: { urgent?: boolean; important?: boolean };
    try {
        parsed = JSON.parse(match[0]);
    } catch {
        throw new Error(`autoClassify failed: could not parse LLM's JSON ("${match[0].slice(0, 200)}").`);
    }
    if (typeof parsed.urgent !== 'boolean' || typeof parsed.important !== 'boolean') {
        throw new Error(`autoClassify failed: LLM's response missing boolean urgent/important ("${match[0].slice(0, 200)}").`);
    }
    return { urgent: parsed.urgent, important: parsed.important };
}

export interface ManageMemoryInput {
    action: 'search' | 'list' | 'stats' | 'clear' | 'wiki_search' | 'wiki_write' | 'wiki_list' | 'wiki_read'
        | 'node_add' | 'node_link' | 'node_list' | 'node_get' | 'node_review' | 'graph_query'
        | 'eisenhower_add' | 'eisenhower_list' | 'eisenhower_complete'
        | 'pomodoro_start' | 'pomodoro_stop' | 'pomodoro_list'
        | 'adr_write' | 'adr_list';
    workspace_root?: string;
    query?: string;
    limit?: number;
    title?: string;
    content?: string;
    tags?: string[];
    links?: string[];
    persona?: string;
    /** Wiki namespace override, e.g. 'global-cyber-tools'. Defaults to the workspace hash. */
    namespace?: string;
    /** For node_add: the DAG memory node to create. */
    node?: {
        type: 'text' | 'image' | 'video' | 'audio' | 'pdf_page';
        content?: string;
        filePath?: string;
        pdfPage?: number;
        tags?: string[];
        halfLifeDays?: number;
        confidence?: number;
    };
    /** For node_get: the node id to fetch. For node_list: pass `tags[0]` to filter by tag. */
    nodeId?: string;
    /** For node_link: source and target node ids and the edge's relation label. */
    from?: string;
    to?: string;
    relation?: string;
    /** For eisenhower_add: the task description. */
    task?: string;
    /** For eisenhower_add: explicit urgency/importance flags — omit both to let the tool prompt for them rather than guess. */
    urgent?: boolean;
    important?: boolean;
    /** For eisenhower_list: filter to one quadrant. Omit to list all open (non-completed) tasks. */
    quadrant?: 'do' | 'schedule' | 'delegate' | 'delete';
    /** For eisenhower_list: include already-completed tasks (default false). */
    includeCompleted?: boolean;
    /** For eisenhower_complete/pomodoro_stop: the task/session id to update. */
    taskId?: string;
    sessionRefId?: string;
    /** For pomodoro_start: a label for the session and its duration (default 25). */
    label?: string;
    durationMinutes?: number;
    /** For pomodoro_stop: true if the session was abandoned rather than completed. */
    aborted?: boolean;
    /** For pomodoro_list: how many recent sessions to return (default 20). */
    pomodoroLimit?: number;
    /**
     * For eisenhower_add: skip explicit urgent/important and let an LLM classify
     * `task`'s text instead. Off by default — must be explicitly opted into per
     * call, never triggers automatically, per standing instruction that LLM
     * assistance here is an optional argument, not a default behavior.
     */
    autoClassify?: boolean;
}

const workspaceScanner = new WorkspaceScanner(process.cwd());

export async function manageMemory(input: ManageMemoryInput) {
    const {
        action, workspace_root: workspaceRoot, query, limit = 10, title, content, tags, links, persona, namespace, node, nodeId, from, to, relation,
        task, urgent, important, quadrant, includeCompleted, taskId, sessionRefId, label, durationMinutes, aborted, pomodoroLimit, autoClassify,
    } = input;
    const wsHash = await workspaceScanner.getWorkspaceHash(workspaceRoot);
    switch (action) {
        case 'eisenhower_add': {
            if (!task) throw new Error('eisenhower_add requires `task`.');
            let resolvedUrgent = urgent;
            let resolvedImportant = important;
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            if (resolvedUrgent === undefined || resolvedImportant === undefined) {
                // autoClassify is opt-in only — omitting urgent/important without it
                // is a caller error, not an implicit trigger for an LLM call. This
                // must never fire by default.
                if (!autoClassify) {
                    throw new Error('eisenhower_add requires explicit `urgent` and `important` booleans, or `autoClassify: true` to have an LLM classify them from `task`.');
                }
                const { urgent: classifiedUrgent, important: classifiedImportant } = await classifyEisenhowerTask(task, productivity);
                resolvedUrgent = classifiedUrgent;
                resolvedImportant = classifiedImportant;
            }
            const created = await productivity.addTask(task, resolvedUrgent, resolvedImportant, tags);
            return { success: true, task: created, autoClassified: autoClassify && (urgent === undefined || important === undefined) };
        }
        case 'adr_write': {
            if (!title || !content) throw new Error('adr_write requires `title` and `content`.');
            const wiki = memoryManager.getWiki(namespace || wsHash, workspaceRoot);
            const page = await wiki.write(title, content, [...(tags || []), 'adr'], links || []);
            return { success: true, page };
        }
        case 'adr_list': {
            const wiki = memoryManager.getWiki(namespace || wsHash, workspaceRoot);
            return { adrs: await wiki.listAdrs() };
        }
        case 'eisenhower_list': {
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            const foundTasks = await productivity.listTasks(quadrant, includeCompleted ?? false);
            return { tasks: foundTasks };
        }
        case 'eisenhower_complete': {
            if (!taskId) throw new Error('eisenhower_complete requires `taskId`.');
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            const updatedTask = await productivity.completeTask(taskId);
            return { success: true, task: updatedTask ?? null };
        }
        case 'pomodoro_start': {
            if (!label) throw new Error('pomodoro_start requires `label`.');
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            const session = await productivity.startPomodoro(label, durationMinutes);
            return { success: true, session };
        }
        case 'pomodoro_stop': {
            if (!sessionRefId) throw new Error('pomodoro_stop requires `sessionRefId`.');
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            const stopped = await productivity.stopPomodoro(sessionRefId, aborted ?? false);
            return { success: true, session: stopped ?? null };
        }
        case 'pomodoro_list': {
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            const sessions = await productivity.listPomodoros(pomodoroLimit);
            return { sessions };
        }
        case 'node_add': {
            if (!node) throw new Error('node_add requires `node`.');
            const dag = memoryManager.getDag(wsHash, workspaceRoot);
            const created = await dag.addNode(node);
            return { success: true, node: created };
        }
        case 'node_link': {
            if (!from || !to || !relation) {
                throw new Error('node_link requires `from`, `to`, and `relation`.');
            }
            const dag = memoryManager.getDag(wsHash, workspaceRoot);
            const edge = await dag.addEdge(from, to, relation);
            return { success: true, edge };
        }
        case 'node_list': {
            const dag = memoryManager.getDag(wsHash, workspaceRoot);
            const nodes = await dag.listNodes(tags?.[0]);
            return { nodes };
        }
        case 'node_get': {
            if (!nodeId) throw new Error('node_get requires `nodeId`.');
            const dag = memoryManager.getDag(wsHash, workspaceRoot);
            const foundNode = await dag.getNode(nodeId);
            return { node: foundNode ?? null };
        }
        case 'node_review': {
            if (!nodeId) throw new Error('node_review requires `nodeId`.');
            const dag = memoryManager.getDag(wsHash, workspaceRoot);
            const updatedNode = await dag.reviewNode(nodeId);
            return { success: true, node: updatedNode ?? null };
        }
        case 'graph_query': {
            const dag = memoryManager.getDag(wsHash, workspaceRoot);
            return await dag.graphQuery();
        }
        case 'wiki_search': {
            const wiki = memoryManager.getWiki(namespace || wsHash, workspaceRoot);
            const results = await wiki.search(query || '', persona);
            return { results: results.slice(0, limit) };
        }
        case 'wiki_write': {
            if (!title || !content) {
                throw new Error('wiki_write requires `title` and `content`.');
            }
            const wiki = memoryManager.getWiki(namespace || wsHash, workspaceRoot);
            const page = await wiki.write(title, content, tags || [], links || []);
            return { success: true, page };
        }
        case 'wiki_list': {
            const wiki = memoryManager.getWiki(namespace || wsHash, workspaceRoot);
            return { pages: await wiki.list() };
        }
        case 'wiki_read': {
            if (!title) {
                throw new Error('wiki_read requires `title`.');
            }
            const wiki = memoryManager.getWiki(namespace || wsHash, workspaceRoot);
            const page = await wiki.read(title);
            return { page };
        }
        case 'stats':
            return await memoryManager.getCompressionStats();
        case 'list':
            return { workspace: workspaceRoot || 'default', hash: wsHash };
        case 'clear':
            await memoryManager.clear(wsHash);
            return { success: true, message: `Cleared memory for workspace ${wsHash}` };
        case 'search': {
            const contextManager = new ContextManager();
            const allResults = await memoryManager.search(wsHash, query);
            // Apply hard count limit
            let results = allResults.slice(0, limit);

            // Apply token limit to prevent pipeline overload
            const MAX_MEMORY_TOKENS = 8000;
            let currentTokens = contextManager.countStringTokens(JSON.stringify(results));

            let truncatedSingle = false;
            if (currentTokens > MAX_MEMORY_TOKENS) {
                // Precompute entry sizes to avoid quadratic JSON.stringify in loop
                const itemTokens = results.map(r => contextManager.countStringTokens(JSON.stringify(r)));
                while (results.length > 1 && currentTokens > MAX_MEMORY_TOKENS) {
                    const removed = results.pop();
                    const removedTokens = itemTokens.pop() ?? 0;
                    currentTokens = Math.max(0, currentTokens - removedTokens);
                }

                if (results.length === 1 && currentTokens > MAX_MEMORY_TOKENS) {
                    const single = results[0] as any;
                    if (single && typeof single.content === 'string' && single.content.length > 20000) {
                        const keywords = query ? query.split(/\s+/).filter(Boolean) : [];
                        results[0] = {
                            ...single,
                            content: quantumCompressWithAnchors(single.content, keywords, 0.6)
                        };
                        truncatedSingle = true;
                        currentTokens = contextManager.countStringTokens(JSON.stringify(results));
                    }
                }
            }

            const wasTruncated = results.length < allResults.length || truncatedSingle;
            return {
                results,
                meta: {
                    total_found: allResults.length,
                    ...(wasTruncated ? { note: `Truncated to ${results.length} results (${currentTokens} tokens) to prevent context overflow.` } : {})
                }
            };
        }
        default:
            throw new Error(`Unsupported action: ${action}`);
    }
}
