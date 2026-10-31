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
  /** Let a failed local edit fall back to free cloud models (sends the file and goal off this machine). Default false. */
  allowCloudFallback: boolean;
  /** What a refuted assumption in the plan does: off = not checked, warn = reported, enforce = the run stops before editing. */
  hypothesisGate: 'off' | 'warn' | 'enforce';
  /** Lets cmd: and test: rows a person wrote in hypotheses.md run an allowlisted command. Off by default: the agent can write that file. */
  hypothesisExec: boolean;
  /** Asks the model for extra assumptions to check, and for one corrected goal when enforce finds a refuted one. Off by default (costs model calls). */
  hypothesisModel: boolean;
}

export function loadCodingAgentsSettings(workspaceRoot: string): CodingAgentsSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceRoot, SETTINGS_FILE), 'utf8'));
    const list = Array.isArray(raw?.skipFailingTests) ? raw.skipFailingTests : [];
    return {
      skipFailingTests: list.filter((p: unknown): p is string => typeof p === 'string' && p.trim() !== ''),
      allowCloudFallback: raw?.allowCloudFallback === true,
      hypothesisGate: raw?.hypothesisGate === 'off' || raw?.hypothesisGate === 'enforce' ? raw.hypothesisGate : 'warn',
      hypothesisExec: raw?.hypothesisExec === true,
      hypothesisModel: raw?.hypothesisModel === true,
    };
  } catch {
    return { skipFailingTests: [], allowCloudFallback: false, hypothesisGate: 'warn', hypothesisExec: false, hypothesisModel: false };
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
