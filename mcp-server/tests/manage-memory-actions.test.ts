import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

// M2: most manage_memory actions had no test. One table: every action answers on its happy path and names the
// missing field when a required one is absent. Runs against a temporary home, never the real ~/.free-llm-mcp.

let home = '';
let ws = '';
let manageMemory: (i: any) => Promise<any>;
const prevHome = process.env.FREE_LLM_MCP_HOME;

beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-home-'));
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-ws-'));
    process.env.FREE_LLM_MCP_HOME = home;
    manageMemory = (await import('../src/tools/manage-memory.js')).manageMemory;
});
afterAll(async () => {
    if (prevHome === undefined) delete process.env.FREE_LLM_MCP_HOME; else process.env.FREE_LLM_MCP_HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fs.rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const call = (input: Record<string, unknown>) => manageMemory({ workspace_root: ws, ...input });

describe('manage_memory: required fields', () => {
    it.each([
        ['eisenhower_add', {}, 'task'],
        ['eisenhower_add', { task: 'x' }, 'urgent'],
        ['adr_write', { title: 't' }, 'content'],
        ['eisenhower_complete', {}, 'taskId'],
        ['pomodoro_start', {}, 'label'],
        ['pomodoro_stop', {}, 'sessionRefId'],
        ['node_add', {}, 'node'],
        ['node_link', { from: 'a' }, 'to'],
        ['node_get', {}, 'nodeId'],
        ['node_review', {}, 'nodeId'],
        ['wiki_write', { title: 't' }, 'content'],
        ['wiki_read', {}, 'title'],
    ])('%s %j names the missing field %s', async (action, extra, field) => {
        await expect(call({ action, ...extra })).rejects.toThrow(new RegExp(field));
    });
});

describe('manage_memory: happy paths', () => {
    it('eisenhower: add with flags, list, complete', async () => {
        const added = await call({ action: 'eisenhower_add', task: 'ship it', urgent: true, important: true });
        expect(added.success).toBe(true);
        const listed = await call({ action: 'eisenhower_list' });
        expect(listed.tasks.some((t: any) => t.task === 'ship it' || t.title === 'ship it')).toBe(true);
        const done = await call({ action: 'eisenhower_complete', taskId: added.task.id });
        expect(done.success).toBe(true);
        const open = await call({ action: 'eisenhower_list' });
        expect(open.tasks.some((t: any) => t.id === added.task.id)).toBe(false);
    });

    it('pomodoro: start, stop, list', async () => {
        const started = await call({ action: 'pomodoro_start', label: 'focus', durationMinutes: 5 });
        expect(started.success).toBe(true);
        const stopped = await call({ action: 'pomodoro_stop', sessionRefId: started.session.id });
        expect(stopped.success).toBe(true);
        expect((await call({ action: 'pomodoro_list' })).sessions.length).toBeGreaterThan(0);
        expect((await call({ action: 'pomodoro_stop', sessionRefId: 'nope' })).session).toBeNull();
    });

    it('dag: node_add, node_link, node_list, node_get, node_review, graph_query', async () => {
        const a = await call({ action: 'node_add', node: { title: 'A', type: 'concept' } });
        const b = await call({ action: 'node_add', node: { title: 'B', type: 'concept' } });
        expect(a.success && b.success).toBe(true);
        expect((await call({ action: 'node_link', from: a.node.id, to: b.node.id, relation: 'depends_on' })).success).toBe(true);
        expect((await call({ action: 'node_list' })).nodes.length).toBeGreaterThanOrEqual(2);
        expect((await call({ action: 'node_get', nodeId: a.node.id })).node.id).toBe(a.node.id);
        expect((await call({ action: 'node_get', nodeId: 'missing' })).node).toBeNull();
        expect((await call({ action: 'node_review', nodeId: a.node.id })).success).toBe(true);
        expect(await call({ action: 'graph_query' })).toBeTruthy();
    });

    it('wiki: write, read, list, search, and a missing page reads as null', async () => {
        expect((await call({ action: 'wiki_write', title: 'Cache Notes', content: 'redis eviction policy' })).success).toBe(true);
        expect((await call({ action: 'wiki_read', title: 'Cache Notes' })).page.content).toContain('redis');
        expect((await call({ action: 'wiki_read', title: 'No Such Page' })).page).toBeNull();
        expect((await call({ action: 'wiki_list' })).pages.length).toBeGreaterThan(0);
        expect((await call({ action: 'wiki_search', query: 'eviction' })).results.length).toBeGreaterThan(0);
    });

    it('adr: write then list', async () => {
        expect((await call({ action: 'adr_write', title: 'Use Postgres', content: 'decided to use postgres' })).success).toBe(true);
        expect((await call({ action: 'adr_list' })).adrs.length).toBeGreaterThan(0);
    });

    it('stats, list, search and clear answer', async () => {
        expect(await call({ action: 'stats' })).toBeTruthy();
        expect((await call({ action: 'list' })).hash).toBeTruthy();
        expect(await call({ action: 'search', query: 'anything' })).toBeTruthy();
        expect((await call({ action: 'clear' })).success).toBe(true);
    });

    it('an unknown action is an error', async () => {
        await expect(call({ action: 'does_not_exist' })).rejects.toThrow();
    });
});
