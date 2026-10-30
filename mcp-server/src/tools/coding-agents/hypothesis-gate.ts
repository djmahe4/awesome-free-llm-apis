import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskItem } from './types.js';
import { loadCodingAgentsSettings } from './settings.js';
import { serializeHypothesesMarkdown, validateHypotheses, type Hypothesis } from './hypotheses.js';

/**
 * The pre-edit gate: the plan's assumptions are written down as hypotheses, checked against the real files, and a
 * refuted one stops the run (enforce) or is reported (warn) before any model call or edit builds on it.
 *
 * Hypotheses are derived from what the caller wrote, with no model involved: every named target file should exist,
 * and every code name the goal mentions should be defined somewhere in the workspace, unless the goal says to
 * create it. A model-proposed hypothesis layer can sit on top of this later; this is the part that cannot hallucinate.
 */

export type GateMode = 'off' | 'warn' | 'enforce';

export const HYPOTHESES_FILE = 'hypotheses.md';
const MAX_HYPOTHESES = 12;
const NOT_NAMES = new Set(['true', 'false', 'null', 'undefined', 'this', 'self', 'return', 'function', 'class', 'const', 'let', 'var', 'async', 'await', 'import', 'export', 'default', 'else', 'elif', 'while', 'for', 'try', 'catch', 'finally', 'new', 'void', 'int', 'string', 'number', 'boolean', 'bool', 'none', 'todo', 'fixme']);

/** The environment variable wins over the workspace settings file; the agent cannot write either. */
export function resolveGateMode(workspaceRoot: string): GateMode {
  const env = process.env.CODING_AGENTS_HYPOTHESIS_GATE;
  if (env === 'off' || env === 'warn' || env === 'enforce') return env;
  return loadCodingAgentsSettings(workspaceRoot).hypothesisGate;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "add a function `x`", "create a new class x", "implement x": the goal wants x to exist afterwards, not before. */
function asksToCreate(goal: string, name: string): boolean {
  const n = esc(name);
  return new RegExp(`\\b(add|create|implement|introduce|write|define|build|new)\\W+(?:(?:an?|the|new)\\W+)*(?:(?:function|method|class|helper|type|interface|const|constant|variable|component|module|handler)\\W+)?\`?${n}\\b`, 'i').test(goal);
}

function asksToCreateFile(goal: string, file: string): boolean {
  const base = esc(path.basename(file));
  return new RegExp(`\\b(create|new file|new module|scaffold|generate|add)\\W+(?:\\w+\\W+){0,4}${base}`, 'i').test(goal);
}

export interface DeriveInput {
  goal: string;
  /** Workspace-relative code files the names may be defined in. */
  files: string[];
  targetFiles?: string[];
  tasks?: TaskItem[];
}

export function deriveHypotheses(input: DeriveInput): Hypothesis[] {
  const out: Array<Omit<Hypothesis, 'id'>> = [];
  const seen = new Set<string>();
  const add = (claim: string, probe: string) => {
    if (seen.has(probe) || out.length >= MAX_HYPOTHESES) return;
    seen.add(probe);
    out.push({ claim, probe, status: 'open' });
  };

  const targets = [...(input.targetFiles ?? []), ...(input.tasks ?? []).map(t => t.targetFile).filter((f): f is string => !!f)];
  for (const f of targets) {
    if (asksToCreateFile(input.goal, f)) continue;
    add(`planned target ${f} exists`, `file:${f}`);
  }

  const names: string[] = [];
  for (const m of input.goal.matchAll(/`([^`\n]{1,80})`/g)) names.push(m[1]);
  for (const m of input.goal.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(\)/g)) names.push(m[1]);
  for (const raw of names) {
    const name = raw.trim().replace(/\(\)$/, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || name.length < 3 || NOT_NAMES.has(name.toLowerCase())) continue;
    if (asksToCreate(input.goal, name)) continue;
    add(`\`${name}\`, which the goal refers to, is defined in the workspace`, `defined:${name}`);
  }

  return out.map((h, i) => ({ id: `h${i + 1}`, ...h }));
}

export interface GateOutcome {
  mode: GateMode;
  hypotheses: Hypothesis[];
  refuted: Hypothesis[];
  blocked: boolean;
  summary: string;
}

export async function runHypothesisGate(input: DeriveInput & { mode: GateMode; workspaceRoot: string }): Promise<GateOutcome> {
  if (input.mode === 'off') return { mode: 'off', hypotheses: [], refuted: [], blocked: false, summary: '' };
  const derived = deriveHypotheses(input);
  const hypotheses = await validateHypotheses(derived, input.workspaceRoot, { files: input.files });
  const refuted = hypotheses.filter(h => h.status === 'refuted');
  const blocked = input.mode === 'enforce' && refuted.length > 0;
  const lines = refuted.map(h => `- ${h.claim}: ${h.evidence}`);
  const summary = refuted.length === 0 ? '' : `${refuted.length} assumption${refuted.length === 1 ? '' : 's'} in the plan ${refuted.length === 1 ? 'is' : 'are'} refuted by the workspace:\n${lines.join('\n')}`;
  return { mode: input.mode, hypotheses, refuted, blocked, summary };
}

/** Writes hypotheses.md next to tasks.md so a person (or the next resume) can read what was checked. */
export async function writeHypothesesFile(workspaceRoot: string, goal: string, list: Hypothesis[]): Promise<void> {
  if (list.length === 0) return;
  await fs.writeFile(path.join(workspaceRoot, HYPOTHESES_FILE), serializeHypothesesMarkdown(goal, list), 'utf-8');
}
