/**
 * MemoryHintMiddleware — central lightweight keyword matching for manage_memory promotion.
 * Inspects request parameters and tool response context. If architectural/planning keywords
 * match, appends a structured `memoryHint` to guide callers to ADRs, wiki, or graph actions.
 */

export interface MemoryHint {
  suggestedTool: 'manage_memory';
  actions: string[];
  reason: string;
}

export const MEMORY_HINT_RULES: Record<string, { actions: string[]; reason: string }> = {
  plan: {
    actions: ['adr_list', 'eisenhower_list'],
    reason: 'The request mentions planning; checking ADRs and the backlog prevents duplicate or contradictory work.',
  },
  architecture: {
    actions: ['adr_list', 'wiki_search'],
    reason: 'The request touches architecture; prior ADRs and wiki design notes provide established context.',
  },
  decision: {
    actions: ['adr_list'],
    reason: 'Architectural or design decisions are recorded in project ADRs; check adr_list first.',
  },
  refactor: {
    actions: ['graph_query', 'wiki_search'],
    reason: 'Refactoring benefits from querying symbol dependencies via graph_query and codebase wiki notes.',
  },
  task: {
    actions: ['eisenhower_list'],
    reason: 'Task tracking is managed via eisenhower_list; check existing items before creating new tasks.',
  },
  review: {
    actions: ['wiki_read'],
    reason: 'Reviewing code or specs aligns with conventions recorded in the workspace wiki.',
  },
  context: {
    actions: ['search'],
    reason: 'Searching prior session memory or wiki helps ground reasoning in historical workspace decisions.',
  },
  documentation: {
    actions: ['wiki_search'],
    reason: 'Consult existing wiki documentation via wiki_search to prevent stale doc drift.',
  },
  comment: {
    actions: ['wiki_read'],
    reason: 'Contract comments and coding standards are documented in workspace wiki standards.',
  },
};

/**
 * Checks an array of strings or fields for matching memory hint keywords.
 * Returns the highest priority hint or null if no keywords match.
 */
export function extractMemoryHint(texts: Array<unknown>): MemoryHint | null {
  const merged = texts
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (!merged) return null;

  for (const [keyword, rule] of Object.entries(MEMORY_HINT_RULES)) {
    // Word boundary check to avoid false positives (e.g. 'plant' matching 'plan')
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(merged)) {
      return {
        suggestedTool: 'manage_memory',
        actions: rule.actions,
        reason: rule.reason,
      };
    }
  }

  return null;
}
