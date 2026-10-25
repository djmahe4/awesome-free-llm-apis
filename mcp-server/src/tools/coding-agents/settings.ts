import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-workspace coding_agents settings: `<workspaceRoot>/.free-llm-mcp/coding-agents.json`.
 * The agent can never write this file (see harness/write-guard.ts), so it cannot skip its own failures.
 *
 *   { "skipFailingTests": ["flaky network call", "/^legacy snapshot \\d+$/"] }
 *
 * skipFailingTests: failing test cases to ignore when judging a check (known pre-failing, flaky or
 * environment-dependent tests). A plain string matches the exact name or a substring of it; "/re/flags"
 * is a regular expression.
 */
export const SETTINGS_FILE = '.free-llm-mcp/coding-agents.json';

export interface CodingAgentsSettings {
  skipFailingTests: string[];
}

export function loadCodingAgentsSettings(workspaceRoot: string): CodingAgentsSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceRoot, SETTINGS_FILE), 'utf8'));
    const list = Array.isArray(raw?.skipFailingTests) ? raw.skipFailingTests : [];
    return { skipFailingTests: list.filter((p: unknown): p is string => typeof p === 'string' && p.trim() !== '') };
  } catch {
    return { skipFailingTests: [] };
  }
}

export function isSkippedTest(name: string, patterns: string[]): boolean {
  return patterns.some(p => {
    const re = p.match(/^\/(.+)\/([a-z]*)$/);
    if (re) {
      try { return new RegExp(re[1], re[2]).test(name); } catch { return false; }
    }
    return name === p || name.includes(p);
  });
}
