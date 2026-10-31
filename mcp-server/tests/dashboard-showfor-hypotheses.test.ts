import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { FIELD_USES, showForTable } from '../scripts/verification/showfor-claims.js';
import { validateHypotheses } from '../src/tools/coding-agents/hypotheses.js';

// Item 10, first case for the hypothesis mechanism: "action X uses input Y" is a hypothesis about our own handlers.
// Only claims the handler source confirms may drive the playground, and the playground must show exactly that.

const root = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

function loadTools(): any[] {
    const src = read('dashboard/js/04-playground-form.js');
    return new Function(`${src.slice(src.indexOf('const TOOLS = ['), src.indexOf('let activeTool = TOOLS[0];'))}; return TOOLS;`)();
}
function loadVisibility(): (f: any, a?: string) => boolean {
    const ctx: any = {};
    vm.createContext(ctx);
    vm.runInContext(read('dashboard/js/00-field-visibility.js') + '\nthis.fieldVisibleFor = fieldVisibleFor;', ctx);
    return ctx.fieldVisibleFor;
}

const TOOLS_WITH_CLAIMS = [...new Set(FIELD_USES.map(u => u.tool))];

describe('the claims are true of the handler source', () => {
    it('every claim\'s probe is confirmed', async () => {
        const list = FIELD_USES.map((u, i) => ({ id: `h${i + 1}`, claim: `${u.tool} ${u.actions.join('/')} ${u.field}`, probe: u.probe, status: 'open' as const }));
        const out = await validateHypotheses(list, root);
        expect(out.filter(h => h.status !== 'confirmed').map(h => `${h.claim}: ${h.evidence}`)).toEqual([]);
    });

    it('a claim names a real action of its tool and a real playground field', () => {
        const tools = loadTools();
        const problems: string[] = [];
        for (const u of FIELD_USES) {
            const t = tools.find(x => x.id === u.tool);
            if (!t) { problems.push(`${u.tool}: no such playground tool`); continue; }
            const options: string[] = t.fields.find((f: any) => f.id === (t.actionField ?? 'action'))?.options ?? [];
            if (!t.fields.some((f: any) => f.id === u.field)) problems.push(`${u.tool}: playground has no field '${u.field}'`);
            for (const a of u.actions) if (!options.includes(a)) problems.push(`${u.tool}: '${a}' is not an action`);
        }
        expect(problems).toEqual([]);
    });
});

describe('the playground shows exactly what the claims say', () => {
    const tools = loadTools();
    const visible = loadVisibility();

    it.each(TOOLS_WITH_CLAIMS)('%s: a field is shown for the actions that use it and hidden for the rest', (toolId) => {
        const t = tools.find(x => x.id === toolId);
        const table = showForTable(toolId);
        const options: string[] = t.fields.find((f: any) => f.id === (t.actionField ?? 'action')).options;
        const problems: string[] = [];
        for (const [field, actions] of Object.entries(table)) {
            const f = t.fields.find((x: any) => x.id === field);
            if (!f) continue;
            for (const a of options.filter(o => o !== '')) {
                const should = actions.includes(a) || (a !== '' && actions.includes('') && toolId === 'coding_agents' && a === 'execute');
                if (visible(f, a) !== should) problems.push(`${toolId}.${field} for '${a}': shown=${visible(f, a)}, claims say ${should}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('movie_tool can send a prompt (generate_assets requires it) and update_artifact_bounds is selectable', () => {
        const t = tools.find(x => x.id === 'movie_tool');
        expect(t.fields.some((f: any) => f.id === 'prompt')).toBe(true);
        expect(t.fields.find((f: any) => f.id === 'action').options).toContain('update_artifact_bounds');
        expect(read('src/mcp/index.ts')).toMatch(/enum: \[[^\]]*'update_artifact_bounds'[^\]]*\]/);
    });

    it('browser_tool can send params and outputDir, and the form parses params as JSON', () => {
        const t = tools.find(x => x.id === 'browser_tool');
        expect(t.fields.some((f: any) => f.id === 'params')).toBe(true);
        expect(t.fields.some((f: any) => f.id === 'outputDir')).toBe(true);
        expect(read('dashboard/js/04-playground-form.js')).toMatch(/f\.id === 'params'/);
    });
});
