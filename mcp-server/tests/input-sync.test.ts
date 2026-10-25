import { describe, it, expect } from 'vitest';
import { handlerForTool, handlerInputType, interfaceFields, findInputDrift } from '../scripts/verification/input-sync.js';

// Pre-commit: for every tool in src/mcp/index.ts, follow the handler it calls to the module it is imported
// from, read the handler's input type there, and fail when a caller-facing field is missing from the MCP
// schema. (coding_agents gained samples/model/think/... and nothing noticed: the old check only compared
// the MCP schema with the dashboard.)

const INDEX = `
import { useFreeLLM } from '../tools/use-free-llm.js';
      if (name === 'use_free_llm' || name === 'free_llm_api') {
        const input = args as any;
        const result = await useFreeLLM(input);
      } else if (name === 'coding_agents') {
        const { CodingAgentsHandler } = await import('../tools/coding-agents.js');
        const result = await CodingAgentsHandler(args as any);
      } else if (name === 'get_token_stats') {
        const result = await getTokenStats();
      }
`;

describe('handlerForTool', () => {
    it('finds a statically imported handler', () => {
        expect(handlerForTool(INDEX, 'use_free_llm')).toEqual({ fn: 'useFreeLLM', module: '../tools/use-free-llm.js' });
    });
    it('finds a dynamically imported handler', () => {
        expect(handlerForTool(INDEX, 'coding_agents')).toEqual({ fn: 'CodingAgentsHandler', module: '../tools/coding-agents.js' });
    });
    it('returns null when the handler cannot be traced', () => {
        expect(handlerForTool(INDEX, 'get_token_stats')).toBeNull();
        expect(handlerForTool(INDEX, 'nope')).toBeNull();
    });
});

describe('handlerInputType', () => {
    it('reads the first parameter type of an exported function or arrow function', () => {
        expect(handlerInputType('export async function CodingAgentsHandler(input: CodingAgentsInput): Promise<R> {', 'CodingAgentsHandler')).toBe('CodingAgentsInput');
        expect(handlerInputType('export const runMovieTool = async (args: MovieToolInput) => {', 'runMovieTool')).toBe('MovieToolInput');
        expect(handlerInputType('export async function f(a: any) {}', 'f')).toBeNull();
    });
});

describe('interfaceFields', () => {
    const SRC = `
export interface CodingAgentsInput {
  goal: string;
  /** shown to callers */
  samples?: number;
  resolve?: {
    action: 'apply' | 'rollback';
    checkpointId?: string;
  };
  /** Set by the repair loop. @internal */
  rewrite?: boolean;
  'quoted-key'?: string;
}
`;
    it('lists top-level fields and separates @internal ones', () => {
        expect(interfaceFields(SRC, 'CodingAgentsInput')).toEqual({ fields: ['goal', 'samples', 'resolve', 'rewrite', 'quoted-key'], internal: ['rewrite'] });
    });
    it('returns null for an unknown type', () => {
        expect(interfaceFields(SRC, 'Other')).toBeNull();
    });
});

describe('findHandlerSource on the real tree', () => {
    it("follows `export * from` to coding_agents' handler and its input type", async () => {
        const path = await import('node:path');
        const { findHandlerSource, findTypeSource } = await import('../scripts/verification/input-sync.js');
        const hs = findHandlerSource(path.resolve('src/tools/coding-agents.ts'), 'CodingAgentsHandler');
        expect(hs?.file.replace(/\\/g, '/')).toMatch(/coding-agents\/pipeline\.ts$/);
        expect(handlerInputType(hs!.src, 'CodingAgentsHandler')).toBe('CodingAgentsInput');
        const ts = findTypeSource(hs!.file, 'CodingAgentsInput');
        expect(interfaceFields(ts!.src, 'CodingAgentsInput')!.fields).toContain('samples');
    });
});

describe('branchArgReads (handlers whose input is not an object type)', () => {
    it('reads destructured and property args in the dispatch branch', async () => {
        const { branchArgReads } = await import('../scripts/verification/input-sync.js');
        const idx = "} else if (name === 'validate_provider') {\n  const { providerId, strict = false } = args as { providerId: string };\n  const x = (args as any).region;\n  const result = await validateProvider(providerId);\n} else if (name === 'other') {";
        expect(branchArgReads(idx, 'validate_provider').sort()).toEqual(['providerId', 'region', 'strict']);
    });
});

describe('browserParamDrift', () => {
    it('a zod param that its handler never reads and unsupported.ts does not refuse is drift', async () => {
        const { browserParamDrift } = await import('../scripts/verification/input-sync.js');
        const schemas = "snapshot: {\n  summary: 's',\n  params: z.object({ verbose: z.boolean().optional(), includeState: z.boolean().optional(), depth: z.number().optional() }),\n},\nclick: {\n  params: z.object({ by: z.enum(['a']), value: z.string(), index: z.number().optional() }),\n},";
        const dispatch = "case 'snapshot': return await handleSnapshot(session, input, sessionId);\ncase 'click': return await handleClick(session, input, sessionId);\nasync function handleSnapshot(s, input) {\n  const x = input.params?.verbose;\n}\nasync function handleClick(s, input) {\n  const { by, value, scrollIntoView = true } = input.params as any;\n}\n";
        const unsupported = "const IGNORED_PARAMS = {\n  snapshot: ['includeState'],\n  click: ['index'],\n};";
        expect(browserParamDrift(schemas, dispatch, unsupported)).toEqual(["browser_tool snapshot: param 'depth' is in the schema but its handler never reads it (implement it or list it in src/browser/unsupported.ts)"]);
    });

    it('the real tree has no browser param drift', async () => {
        const fs = await import('node:fs');
        const { browserParamDrift } = await import('../scripts/verification/input-sync.js');
        expect(browserParamDrift(fs.readFileSync('src/browser/actionSchemas.ts', 'utf8'), fs.readFileSync('src/browser/dispatch.ts', 'utf8'), fs.readFileSync('src/browser/unsupported.ts', 'utf8'))).toEqual([]);
    });
});

describe('findInputDrift', () => {
    it('reports caller-facing fields missing from the MCP schema, never @internal ones', () => {
        expect(findInputDrift('coding_agents', { fields: ['goal', 'samples', 'rewrite'], internal: ['rewrite'] }, ['goal'])).toEqual(["coding_agents: input field 'samples' is missing from the MCP inputSchema"]);
        expect(findInputDrift('coding_agents', { fields: ['goal'], internal: [] }, ['goal'])).toEqual([]);
    });
});
