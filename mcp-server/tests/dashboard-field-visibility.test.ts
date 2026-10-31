import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Item 10 of the reverse-tool plan: sub-actions need different inputs, and the playground must hide the ones
// that do not apply instead of showing every field of every action.

const dash = path.join(__dirname, '..', 'dashboard', 'js');
const read = (f: string) => fs.readFileSync(path.join(dash, f), 'utf-8');

function loadVisibility(): (f: any, a?: string) => boolean {
    const ctx: any = {};
    vm.createContext(ctx);
    vm.runInContext(read('00-field-visibility.js') + '\nthis.fieldVisibleFor = fieldVisibleFor;', ctx);
    return ctx.fieldVisibleFor;
}

function loadTools(): any[] {
    const src = read('04-playground-form.js');
    const start = src.indexOf('const TOOLS = [');
    const end = src.indexOf('let activeTool = TOOLS[0];');
    return new Function(`${src.slice(start, end)}; return TOOLS;`)();
}

describe('fieldVisibleFor', () => {
    const f = loadVisibility();
    it('a field without showFor is always visible', () => {
        expect(f({ id: 'x' }, 'anything')).toBe(true);
        expect(f({ id: 'x', showFor: [] }, 'anything')).toBe(true);
    });
    it('a field with showFor is visible only for those actions', () => {
        const field = { id: 'x', showFor: ['a', 'b'] };
        expect(f(field, 'a')).toBe(true);
        expect(f(field, 'c')).toBe(false);
    });
    it('with no action chosen every field is shown', () => {
        expect(f({ id: 'x', showFor: ['a'] }, '')).toBe(true);
        expect(f({ id: 'x', showFor: ['a'] }, undefined)).toBe(true);
    });
});

describe('playground field data', () => {
    const tools = loadTools();
    const actionsOf = (t: any) => (t.fields.find((x: any) => x.id === (t.actionField ?? 'action'))?.options ?? []) as string[];

    it('every showFor value is a real action of its tool', () => {
        const problems: string[] = [];
        for (const t of tools) for (const fld of t.fields) for (const a of fld.showFor ?? []) {
            if (!actionsOf(t).includes(a)) problems.push(`${t.id}.${fld.id}: '${a}' is not an action`);
        }
        expect(problems).toEqual([]);
    });

    it.each([
        ['manage_memory', 'src/tools/manage-memory.ts'],
        ['agent_harness', 'src/tools/agent-harness.ts'],
    ])('%s: every input its handler says an action requires is visible for that action', (toolId, srcFile) => {
        const t = tools.find((x: any) => x.id === toolId);
        const src = fs.readFileSync(path.join(__dirname, '..', srcFile), 'utf-8');
        const f = loadVisibility();
        const problems: string[] = [];
        for (const m of src.matchAll(/'([a-z_]+) requires ((?:`[A-Za-z_]+`[^'`]{0,6})+)/g)) {
            const action = m[1];
            if (!actionsOf(t).includes(action)) continue;
            for (const name of [...m[2].matchAll(/`([A-Za-z_]+)`/g)].map(x => x[1])) {
                const fld = t.fields.find((x: any) => x.id === name);
                if (!fld) problems.push(`${toolId}: no field '${name}' for ${action}`);
                else if (!f(fld, action)) problems.push(`${toolId}: '${name}' is hidden for ${action} but required`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('agent_harness: rerun/reorchestrate need runId, role; approve/reject need approvalId', () => {
        const t = tools.find((x: any) => x.id === 'agent_harness');
        const f = loadVisibility();
        const vis = (id: string, a: string) => f(t.fields.find((x: any) => x.id === id), a);
        for (const a of ['rerun', 'reorchestrate']) { expect(vis('runId', a)).toBe(true); expect(vis('role', a)).toBe(true); expect(vis('goal', a)).toBe(false); }
        for (const a of ['approve', 'reject']) { expect(vis('approvalId', a)).toBe(true); expect(vis('role', a)).toBe(false); }
        expect(vis('goal', 'deploy')).toBe(true);
        expect(vis('approvalId', 'deploy')).toBe(false);
    });

    it('manage_memory: each action shows its own inputs and hides unrelated ones', () => {
        const t = tools.find((x: any) => x.id === 'manage_memory');
        const f = loadVisibility();
        const vis = (id: string, a: string) => f(t.fields.find((x: any) => x.id === id), a);
        expect(vis('content', 'wiki_write')).toBe(true);
        expect(vis('content', 'node_link')).toBe(false);
        expect(vis('from', 'node_link')).toBe(true);
        expect(vis('from', 'search')).toBe(false);
        expect(vis('query', 'search')).toBe(true);
        expect(vis('node', 'node_add')).toBe(true);
    });
});

describe('wiring', () => {
    it('index.html loads the visibility helper before the playground, and the form uses it', () => {
        const html = fs.readFileSync(path.join(dash, '..', 'index.html'), 'utf-8');
        expect(html.indexOf('/js/00-field-visibility.js')).toBeGreaterThan(-1);
        expect(html.indexOf('/js/00-field-visibility.js')).toBeLessThan(html.indexOf('/js/04-playground-form.js'));
        const form = read('04-playground-form.js');
        expect(form).toContain('fieldVisibleFor(f, action)');   // hides wrappers
        expect(form).toContain('fieldVisibleFor(f, currentAction)'); // and does not send hidden values
    });

    it('load_skill_prompt switches on its `type` field', () => {
        const t = loadTools().find((x: any) => x.id === 'load_skill_prompt');
        const f = loadVisibility();
        expect(t.actionField).toBe('type');
        expect(f(t.fields.find((x: any) => x.id === 'name'), 'load')).toBe(true);
        expect(f(t.fields.find((x: any) => x.id === 'name'), 'list')).toBe(false);
        expect(f(t.fields.find((x: any) => x.id === 'keywords'), 'search')).toBe(true);
    });
});
