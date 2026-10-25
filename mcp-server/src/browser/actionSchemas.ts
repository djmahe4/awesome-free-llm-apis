import { z } from 'zod';

/**
 * Single source of truth for browser_tool's action surface. src/mcp/index.ts
 * generates its MCP inputSchema from actionEnum()/renderActionDocs() instead of
 * hand-writing them, so the schema/type drift that left domainContext,
 * filenameBase, continueFromState, forceRegenerateScript and deepScrapeLimit
 * unreachable over MCP (BrowserScrapeInput vs the old inputSchema) cannot recur.
 */

const waitSpec = z.object({
    until: z.enum(['selector', 'text', 'network-idle', 'dom-stable', 'depth', 'timeout']).optional(),
    value: z.string().optional(),
    timeoutMs: z.number().optional(),
    pollMs: z.number().optional(),
}).optional();

export const BrowserActions = {
    navigate: {
        summary: 'Open a URL in the session; installs the network interceptor.',
        // url is optional here: callers may send it top-level (the harness does) or in params; parseInput merges them.
        params: z.object({ url: z.string().optional(), waitFor: waitSpec, installInterceptor: z.boolean().optional() }),
    },
    snapshot: {
        summary: 'Take an accessibility-tree snapshot of the current page.',
        params: z.object({ verbose: z.boolean().optional(), includeState: z.boolean().optional(), includeDepth: z.boolean().optional() }),
    },
    click: {
        summary: 'Click an element found by label/role/text/uid/selector.',
        params: z.object({
            by: z.enum(['label', 'role', 'text', 'uid', 'selector']),
            value: z.string(),
            index: z.number().optional(),
            scrollIntoView: z.boolean().optional(),
            waitFor: waitSpec,
        }),
    },
    scroll: {
        summary: 'Scroll the window, a container, or into view of an element.',
        params: z.object({
            target: z.enum(['window', 'container', 'element']),
            selectorOrLabel: z.string().optional(),
            to: z.union([z.enum(['bottom', 'top', 'into-view']), z.number()]).optional(),
            steps: z.number().optional(),
        }),
    },
    wait: {
        summary: 'Wait for a selector, text, network-idle, dom-stable, depth, or timeout.',
        params: z.object({
            until: z.enum(['selector', 'text', 'network-idle', 'dom-stable', 'depth', 'timeout']),
            value: z.string().optional(),
            timeoutMs: z.number().optional(),
            pollMs: z.number().optional(),
        }),
    },
    evaluate: {
        summary: 'Run a JS function in the page; returns a structured {ok,data|error}.',
        params: z.object({ function: z.string(), args: z.record(z.string(), z.any()).optional() }),
    },
    network: {
        summary: 'List/get/drain/clear captured network requests, optionally with bodies.',
        params: z.object({
            op: z.enum(['list', 'get', 'drain', 'clear']),
            filter: z.string().optional(),
            withBodies: z.boolean().optional(),
            limit: z.number().optional(),
        }),
    },
    api_replay: {
        summary: 'Rank discovered API endpoints, mine ids, and replay them in-page.',
        params: z.object({
            endpoints: z.union([z.array(z.string()), z.literal('auto')]).optional(),
            idOverrides: z.record(z.string(), z.string()).optional(),
            maxCalls: z.number().optional(),
            flatten: z.boolean().optional(),
            export: z.boolean().optional(),
        }),
    },
    extract: {
        summary: 'Extract structured records via auto/script/api/dom strategy (strict by default).',
        params: z.object({
            strategy: z.enum(['auto', 'script', 'api', 'dom']).optional(),
            script: z.string().optional(),
            schemaHint: z.string().optional(),
        }),
    },
    deep_scrape: {
        summary: 'Drain the pending-URL queue, visiting each and running perItemActions.',
        params: z.object({ limit: z.number().optional(), linkFilter: z.string().optional() }),
    },
    screenshot: {
        summary: 'Save a screenshot to disk; returns the path only, never base64.',
        params: z.object({ fullPage: z.boolean().optional(), selectorOrLabel: z.string().optional(), filename: z.string().optional() }),
    },
    checkpoint: {
        summary: 'List/load/save/pause/resume/delete session checkpoints.',
        params: z.object({ op: z.enum(['list', 'load', 'save', 'pause', 'resume', 'delete']) }),
    },
    session: {
        summary: 'Get status of or close the live browser session.',
        params: z.object({ op: z.enum(['status', 'close']) }),
    },
    site_memory: {
        summary: 'Read/write remembered per-domain endpoints/selectors/labels.',
        params: z.object({ op: z.enum(['read', 'write']), domain: z.string().optional(), kind: z.string().optional(), note: z.string().optional() }),
    },
    scrape: {
        summary: 'Legacy one-call macro: navigate, extract, export, checkpoint.',
        params: z.object({}).passthrough(),
    },
} as const;

export type BrowserAction = keyof typeof BrowserActions;

export interface BrowserToolInput {
    action: BrowserAction;
    url?: string;
    sessionId?: string;
    outputDir?: string;
    userInstructions?: string;
    strict?: boolean;
    params?: Record<string, any>;
}

export function actionEnum(): BrowserAction[] {
    return Object.keys(BrowserActions) as BrowserAction[];
}

export function renderActionDocs(): string {
    return actionEnum().map(a => `${a}: ${BrowserActions[a].summary}`).join(' | ');
}

const topLevelSchema = z.object({
    action: z.enum(actionEnum() as [BrowserAction, ...BrowserAction[]]),
    url: z.string().optional(),
    sessionId: z.string().optional(),
    outputDir: z.string().optional(),
    userInstructions: z.string().optional(),
    strict: z.boolean().optional(),
    params: z.record(z.string(), z.any()).optional(),
});

/** One readable line per problem ("params.by: ...") instead of zod's JSON dump. */
function readable(err: unknown): Error {
    const issues = (err as { issues?: Array<{ path: Array<string | number>; message: string }> })?.issues;
    if (!Array.isArray(issues)) return err instanceof Error ? err : new Error(String(err));
    return new Error(issues.map(i => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('; '));
}

export function parseInput(raw: unknown): BrowserToolInput {
    let top: z.infer<typeof topLevelSchema>;
    try { top = topLevelSchema.parse(raw); } catch (err) { throw readable(err); }
    const actionDef = BrowserActions[top.action];
    // navigate accepts the url top-level or in params; params.url wins when both are present.
    const rawParams = top.action === 'navigate' && top.url && !(top.params && 'url' in top.params)
        ? { ...(top.params ?? {}), url: top.url }
        : (top.params ?? {});
    // zod drops keys it does not know, so a misspelled option used to vanish silently (the scrape macro is
    // a passthrough and keeps everything)
    const shape = (actionDef.params as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape && top.action !== 'scrape') {
        const unknown = Object.keys(rawParams).filter(k => !(k in shape));
        if (unknown.length > 0) {
            throw new Error(`Unknown option(s) for ${top.action}: ${unknown.join(', ')}. Allowed: ${Object.keys(shape).join(', ')}.`);
        }
    }
    let params;
    try { params = actionDef.params.parse(rawParams); } catch (err) {
        // issue paths here are relative to params, so say so: 'params.by: ...'
        throw new Error(readable(err).message.split('; ').map(m => `params.${m}`).join('; '));
    }
    return { ...top, params };
}
