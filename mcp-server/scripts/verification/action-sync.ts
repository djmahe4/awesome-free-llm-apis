/**
 * Action-enum sync: every value of a tool's top-level `action` enum in src/mcp/index.ts must be
 * selectable in the dashboard playground form and listed in the Quickstart table.
 * (Parameter-name drift stays a notice in verify-precommit.ts; a missing *action* means a
 * capability that exists server-side but cannot be reached from, or found in, the frontend.)
 */

const enumValues = (s: string) => [...s.matchAll(/'([^']*)'/g)].map(m => m[1]).filter(Boolean);

/** tool -> action enum values, for tools that declare a top-level `action` property. */
export function extractServerActions(toolsBlock: string, registered: Set<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of toolsBlock.split(/\{\s*name:\s*'/)) {
    const name = part.match(/^([a-z0-9_]+)'/)?.[1];
    if (!name || !registered.has(name)) continue;
    // First `action:` key whose enum follows; nested objects (e.g. a sub-action) come later in the schema.
    const m = part.match(/\n\s*action:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]*)\]/);
    if (m) out[name] = enumValues(m[1]);
  }
  return out;
}

/** tool -> option values of the playground's `action` select. */
export function extractPlaygroundActions(appContent: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const start = appContent.indexOf('const TOOLS = [');
  const end = appContent.indexOf('let activeTool = TOOLS[0];');
  if (start === -1 || end === -1) return out;
  for (const b of appContent.slice(start, end).split(/\n\s*\{\s*\n\s*id:\s*'/).slice(1)) {
    const tool = b.slice(0, b.indexOf("'"));
    const m = b.match(/id:\s*'action'[^\n]*?options:\s*\[([^\]]*)\]/);
    if (m) out[tool] = enumValues(m[1]);
  }
  return out;
}

/** tool -> text of the `action` row in its Quickstart table. */
export function extractQuickstartActionRows(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const card of html.split('<details class="qs-tool-card"').slice(1)) {
    const tool = card.match(/<span class="qs-tool-name">([a-z0-9_]+)<\/span>/)?.[1];
    const row = card.match(/<tr><td><code>action<\/code>([\s\S]*?)<\/tr>/)?.[1];
    if (tool && row) out[tool] = row;
  }
  return out;
}

export function findActionDrift(
  server: Record<string, string[]>,
  playground: Record<string, string[]>,
  quickstart: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [tool, actions] of Object.entries(server)) {
    const pg = playground[tool];
    const qs = quickstart[tool];
    if (pg) {
      const missing = actions.filter(a => !pg.includes(a));
      if (missing.length) problems.push(`[${tool}] playground action select is missing: ${missing.join(', ')}`);
    }
    if (qs !== undefined) {
      const missing = actions.filter(a => !new RegExp(`(^|[^a-z0-9_])${a}([^a-z0-9_]|$)`).test(qs.replace(/<[^>]+>/g, ' ')));
      if (missing.length) problems.push(`[${tool}] Quickstart action row is missing: ${missing.join(', ')}`);
    }
  }
  return problems;
}
