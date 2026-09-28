import { memoryManager } from '../memory/index.js';
import { WorkspaceScanner } from '../cache/workspace.js';
import { ContextManager } from '../utils/ContextManager.js';
import { quantumCompressWithAnchors } from '../utils/quantum-compression.js';

export interface ManageMemoryInput {
    action: 'search' | 'list' | 'stats' | 'clear' | 'wiki_search' | 'wiki_write' | 'wiki_list' | 'wiki_read'
        | 'node_add' | 'node_link' | 'node_list' | 'node_get' | 'node_review' | 'graph_query'
        | 'eisenhower_add' | 'eisenhower_list' | 'eisenhower_complete'
        | 'pomodoro_start' | 'pomodoro_stop' | 'pomodoro_list';
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
}

const workspaceScanner = new WorkspaceScanner(process.cwd());

export async function manageMemory(input: ManageMemoryInput) {
    const {
        action, workspace_root: workspaceRoot, query, limit = 10, title, content, tags, links, persona, namespace, node, nodeId, from, to, relation,
        task, urgent, important, quadrant, includeCompleted, taskId, sessionRefId, label, durationMinutes, aborted, pomodoroLimit,
    } = input;
    const wsHash = await workspaceScanner.getWorkspaceHash(workspaceRoot);
    switch (action) {
        case 'eisenhower_add': {
            if (!task) throw new Error('eisenhower_add requires `task`.');
            // Explicit urgent/important is the "without LLM help" path — required
            // for now since classifying from text alone (the "with LLM help" path)
            // is separately-scoped work, not built in this pass.
            if (urgent === undefined || important === undefined) {
                throw new Error('eisenhower_add requires explicit `urgent` and `important` booleans.');
            }
            const productivity = memoryManager.getProductivity(wsHash, workspaceRoot);
            const created = await productivity.addTask(task, urgent, important, tags);
            return { success: true, task: created };
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
