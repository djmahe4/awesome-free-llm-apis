import type { BrowserToolInput } from './actionSchemas.js';

/**
 * Options the schema advertises but no handler reads. They used to be accepted and silently ignored (or
 * failed late, after Chrome was launched). dispatch refuses them up front instead. When a handler learns
 * to honour one, delete it from this table and add a test for the behaviour.
 */
const IGNORED_PARAMS: Partial<Record<string, string[]>> = {
    navigate: ['waitFor', 'installInterceptor'],
    snapshot: ['includeState', 'includeDepth'],
    click: ['index', 'waitFor'],
    scroll: ['steps'],
    network: ['filter', 'withBodies'],
    api_replay: ['endpoints', 'idOverrides'],
    extract: ['script', 'schemaHint'],
    deep_scrape: ['linkFilter'],
    screenshot: ['selectorOrLabel'],
};

/** param -> values that are in the schema's enum but have no handler branch. */
const UNHANDLED_VALUES: Partial<Record<string, Record<string, string[]>>> = {
    wait: { until: ['depth'] },
    network: { op: ['get'] },
    extract: { strategy: ['script', 'dom'] },
    checkpoint: { op: ['delete'] },
};

/** Actions in the schema with no handler at all. */
const UNIMPLEMENTED_ACTIONS = new Set(['site_memory']);

/** Names of advertised-but-unimplemented options present in this call (empty when the call is fine). */
export function findUnsupportedOptions(input: Pick<BrowserToolInput, 'action' | 'params'>): string[] {
    if (UNIMPLEMENTED_ACTIONS.has(input.action)) return [`action '${input.action}'`];
    const params = (input.params ?? {}) as Record<string, unknown>;
    const found: string[] = [];
    for (const name of IGNORED_PARAMS[input.action] ?? []) {
        if (params[name] !== undefined) found.push(name);
    }
    for (const [name, values] of Object.entries(UNHANDLED_VALUES[input.action] ?? {})) {
        const v = params[name];
        if (typeof v === 'string' && values.includes(v)) found.push(`${name}: '${v}'`);
    }
    return found;
}
