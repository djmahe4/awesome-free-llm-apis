import fs from 'node:fs/promises';

import path from 'node:path';

import type { TaskItem } from './types.js';

import { loadCodingAgentsSettings } from './settings.js';

import { parseHypothesesMarkdown, parseProbe, serializeHypothesesMarkdown, validateHypotheses, type Hypothesis } from './hypotheses.js';



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



const COMMON_EXTERNAL_OR_STDLIB_SYMBOLS = new Set([

  'fzstd',

  // Python builtins, stdlib & typing

  'bytesio', 'stringio', 'path', 'purepath', 'exception', 'valueerror', 'typeerror', 'keyerror',

  'indexerror', 'attributeerror', 'runtimeerror', 'notimplementederror', 'ioerror', 'oserror',

  'filenotfounderror', 'zerodivisionerror', 'importerror', 'modulenotfounderror', 'stopiteration',

  'generatorexit', 'keyboardinterrupt', 'systemexit', 'json', 'math', 'sys', 'os', 're', 'time',

  'datetime', 'random', 'hashlib', 'hmac', 'base64', 'subprocess', 'threading', 'multiprocessing',

  'asyncio', 'socket', 'struct', 'urllib', 'http', 'logging', 'unittest', 'pytest', 'defaultdict',

  'deque', 'counter', 'ordereddict', 'namedtuple', 'optional', 'union', 'list', 'dict', 'set',

  'tuple', 'any', 'callable', 'iterable', 'iterator', 'generator',

  // Common object methods across Python & JS

  'encode', 'decode', 'flush', 'getvalue', 'read', 'write', 'close', 'seek', 'tell', 'open',

  'print', 'len', 'range', 'bytes', 'str', 'type', 'isinstance', 'issubclass', 'super',

  'hasattr', 'getattr', 'setattr', 'delattr', 'iter', 'next', 'repr', 'format', 'map', 'filter',

  'zip', 'sum', 'min', 'max', 'all', 'any', 'id', 'hash', 'chr', 'ord', 'bin', 'hex', 'oct',

  'abs', 'round', 'pow', 'divmod', 'slice', 'strip', 'split', 'join', 'replace', 'lower', 'upper',

  'startswith', 'endswith', 'find', 'count', 'append', 'extend', 'insert', 'pop', 'remove',

  'clear', 'index', 'keys', 'values', 'items', 'get', 'update', 'sort', 'reverse', 'copy',

  // JS/TS standard objects & methods

  'array', 'object', 'function', 'string', 'number', 'symbol', 'bigint', 'date', 'regexp',

  'weakmap', 'weakset', 'promise', 'error', 'reflect', 'proxy', 'buffer', 'uint8array', 'int8array',

  'arraybuffer', 'dataview', 'process', 'console', 'tostring', 'valueof', 'push', 'shift',

  'unshift', 'splice', 'indexof', 'lastindexof', 'includes', 'foreach', 'findindex', 'some',

  'every', 'flat', 'flatmap', 'trim', 'charcodeat', 'charat', 'substring', 'match', 'test',

  'exec', 'replaceall', 'entries', 'has', 'add', 'delete',

  // Common external challenge/networking libraries

  'scapy', 'ether', 'ip', 'tcp', 'udp', 'dns', 'icmp', 'arp', 'raw', 'packet', 'sniff',

  'rdpcap', 'wrpcap', 'pcapreader', 'pcapwriter', 'hexdump',

]);



function asksToImport(goal: string, name: string): boolean {
  const n = esc(name);
  return new RegExp(`\\b(?:import|from)\\s+[\\w.,\\s]*\\b${n}\\b`, 'i').test(goal);
}



/** The environment variable wins over the workspace settings file; the agent cannot write either. */

export function resolveGateMode(workspaceRoot: string): GateMode {

  const env = process.env.CODING_AGENTS_HYPOTHESIS_GATE;

  if (env === 'off' || env === 'warn' || env === 'enforce') return env;

  return loadCodingAgentsSettings(workspaceRoot).hypothesisGate;

}



const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SQLITE_SCHEMA_NAMES = new Set(['threads', 'folder_paths', 'data_type', 'updated_at']);
const ENVIRONMENT_NAMES = new Set(['localappdata', 'zed_threads_db', 'zed_data_dir']);

function isSchemaOrEnvironmentName(goal: string, name: string): boolean {
  const lowerName = name.toLowerCase();
  const matches = goal.matchAll(new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`, 'gi'));
  for (const match of matches) {
    const index = match.index ?? 0;
    const before = goal.slice(0, index);
    const after = goal.slice(index + match[0].length);
    const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
    const nextBoundary = [after.indexOf('.'), after.indexOf(';'), after.indexOf('\n')].filter(value => value >= 0);
    const clauseEnd = nextBoundary.length ? Math.min(...nextBoundary) : after.length;
    const context = `${before.slice(Math.max(boundary + 1, index - 80))} ${after.slice(0, Math.min(clauseEnd, 80))}`;
    if (SQLITE_SCHEMA_NAMES.has(lowerName) && /\b(?:sqlite|database|db|table|column|schema|field)\b/i.test(context)) return true;
    if (ENVIRONMENT_NAMES.has(lowerName) && (
      (name === name.toUpperCase() && /[A-Z]/.test(name))
      || /\b(?:environment variable|env var|setting|configuration)\b/i.test(context)
    )) return true;
  }
  return false;
}



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

  const spans = input.goal.split('`');

  for (let i = 1; i < spans.length - 1; i += 2) {

    const s = spans[i].trim();

    if (s.startsWith('.')) continue; // method access inside backticks (.encode)

    // Check if preceded by dot in the goal text

    const idx = input.goal.indexOf('`' + spans[i] + '`');

    if (idx > 0 && input.goal[idx - 1] === '.') continue;

    names.push(s);

  }

  for (const m of input.goal.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(\)/g)) {

    if (m.index !== undefined && m.index > 0 && input.goal[m.index - 1] === '.') continue; // method call like .flush()

    names.push(m[1]);

  }

  for (const raw of names) {

    const name = raw.trim().replace(/^\.+/, '').replace(/\(\)$/, '');

    const lower = name.toLowerCase();

    if (!/^[A-Za-z_$][\w$]*$/.test(name) || name.length < 3 || NOT_NAMES.has(lower) || COMMON_EXTERNAL_OR_STDLIB_SYMBOLS.has(lower) || isSchemaOrEnvironmentName(input.goal, name)) continue;

    if (asksToCreate(input.goal, name) || asksToImport(input.goal, name)) continue;

    add(`\`${name}\`, which the goal refers to, is defined in the workspace`, `defined:${name}`);

  }

  // A module the goal tells the editor to use must resolve (a misspelled `node:` built-in). Checked with the same
  // resolver as the post-edit import guard, before any edit is made on top of it.
  const moduleHost = input.targetFiles?.[0] ?? targets[0];
  if (moduleHost) {
    const specs = new Set<string>();
    for (const m of input.goal.matchAll(/\bnode:[a-z0-9_][\w/]*/gi)) specs.add(m[0]);
    for (const spec of specs) add(`the goal uses the module \`${spec}\`, which resolves from ${moduleHost}`, `module:${spec}@${moduleHost}`);
  }



  return out.map((h, i) => ({ id: `h${i + 1}`, ...h }));

}



export interface GateOutcome {

  mode: GateMode;

  hypotheses: Hypothesis[];

  refuted: Hypothesis[];

  blocked: boolean;

  summary: string;

  /** The goal the run should use: the corrected one when a re-plan succeeded, otherwise the one passed in. */

  goal: string;

  replanned: boolean;

  /** Model proposals that were not turned into checks, with the reason. */

  rejected: Array<{ probe: string; reason: string }>;

}



/** A model's extra assumptions: only the claim and the probe are taken, any status it wrote is ignored. */

export type Proposer = (ctx: { goal: string; files: string[]; derived: Hypothesis[] }) => Promise<Array<{ claim: string; probe: string; status?: unknown }>>;

/** Returns a corrected goal given the assumptions the workspace refuted. Called at most once per run. */

export type Reviser = (ctx: { goal: string; refuted: Hypothesis[]; /** for each refuted name, names that do exist in the workspace and share a word with it */ similar: Record<string, string[]> }) => Promise<string>;



export interface GateInput extends DeriveInput {

  mode: GateMode;

  workspaceRoot: string;

  propose?: Proposer;

  revise?: Reviser;

}



/**

 * A person can add their own rows to hypotheses.md. Their ids start with "u" (u1, u2, ...); every other row belongs to

 * the run that wrote it and is rebuilt from the goal each time. A person's row is kept and checked like any other,

 * but the status they typed is never believed: the probe decides.

 */

const isHumanId = (id: string) => /^u\w*$/i.test(id);



async function readHumanRows(workspaceRoot: string): Promise<Hypothesis[]> {

  try {

    const md = await fs.readFile(path.join(workspaceRoot, HYPOTHESES_FILE), 'utf-8');

    return parseHypothesesMarkdown(md).filter(h => isHumanId(h.id)).map(h => ({ id: h.id, claim: h.claim, probe: h.probe, status: 'open' as const }));

  } catch {

    return [];

  }

}



const VACUOUS =/^(?:\.\*|\.\+|\^|\$|\.|\*|\^\$|\^\.\*\$?)$/;



/** Why a model-proposed probe is not worth running, or null. It must name something that can be wrong, and must not execute anything. */

function rejectProposal(probe: string): string | null {

  const p = parseProbe(probe);

  if (!p) return 'not a probe the checker can run';

  if (p.kind === 'cmd' || p.kind === 'test') return 'command probes are not taken from a model';

  if (p.kind === 'grep' && (p.pattern.trim().length < 3 || VACUOUS.test(p.pattern.trim()))) return 'a pattern that matches almost anything proves nothing';

  return null;

}



/** A refuted row from the model is a guess about how to test something, not a fact about the code; it is reported, never blocking. */

const isModelId = (id: string) => /^m\d+$/.test(id);



const DEFINITION = /(?:function|class|def|const|let|var|interface|type|struct|fn|func|enum)\s+([A-Za-z_$][\w$]*)/g;

const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).map(w => w.toLowerCase()).filter(w => w.length > 2);



/** Names defined in the workspace that share a word with a name the goal used and the code does not have (fetchUser -> getUser). */

export async function similarNames(missing: string[], workspaceRoot: string, files: string[]): Promise<Record<string, string[]>> {

  const defined = new Set<string>();

  for (const f of files.slice(0, 100)) {

    try {

      const text = (await fs.readFile(path.join(workspaceRoot, f), 'utf-8')).slice(0, 200_000);

      for (const m of text.matchAll(DEFINITION)) defined.add(m[1]);

    } catch { /* unreadable file: skip */ }

  }

  const out: Record<string, string[]> = {};

  for (const name of missing) {

    const mine = new Set(words(name));

    const scored = [...defined].map(d => ({ d, n: words(d).filter(w => mine.has(w)).length })).filter(x => x.n > 0 && x.d !== name);

    scored.sort((a, b) => b.n - a.n || a.d.localeCompare(b.d));

    if (scored.length) out[name] = scored.slice(0, 5).map(x => x.d);

  }

  return out;

}



async function hypothesesFor(input: GateInput, goal: string, humanRows: Hypothesis[], exec: boolean): Promise<{ hypotheses: Hypothesis[]; rejected: GateOutcome['rejected'] }> {

  const derived = deriveHypotheses({ ...input, goal });

  const rejected: GateOutcome['rejected'] = [];

  const taken = new Set(derived.map(h => h.probe));

  const proposed: Array<Omit<Hypothesis, 'id'>> = [];

  if (input.propose) {

    try {

      for (const raw of await input.propose({ goal, files: input.files, derived })) {

        const probe = String(raw?.probe ?? '').trim();

        const why = rejectProposal(probe);

        if (why) { rejected.push({ probe, reason: why }); continue; }

        if (taken.has(probe)) continue;

        taken.add(probe);

        proposed.push({ claim: String(raw?.claim ?? probe).slice(0, 200), probe, status: 'open' });

      }

    } catch { /* a model that is down must not take the mechanical checks with it */ }

  }

  const room = Math.max(0, MAX_HYPOTHESES - derived.length);

  const model = proposed.slice(0, room).map((h, i) => ({ id: 'm' + (i + 1), ...h }));

  const human = humanRows.filter(h => !taken.has(h.probe));

  // commands only ever run for rows a person wrote, and only when the workspace settings allow it

  const checkedMachine = await validateHypotheses([...derived, ...model], input.workspaceRoot, { files: input.files });

  const checkedHuman = await validateHypotheses(human, input.workspaceRoot, { files: input.files, allowExec: exec });

  // a probe nobody can run proves nothing either way: leave the person's row open instead of calling it refuted

  const humanFinal = checkedHuman.map(h => !parseProbe(h.probe)

    ? { ...h, status: 'open' as const, evidence: 'probe not recognised, so nothing was checked (use file:, defined:, symbol:, arity:, grep:, cite:, cmd: or test:)' }

    : h);

  return { hypotheses: [...checkedMachine, ...humanFinal], rejected };

}



export async function runHypothesisGate(input: GateInput): Promise<GateOutcome> {

  if (input.mode === 'off') return { mode: 'off', hypotheses: [], refuted: [], blocked: false, summary: '', goal: input.goal, replanned: false, rejected: [] };

  const human = await readHumanRows(input.workspaceRoot);

  const exec = loadCodingAgentsSettings(input.workspaceRoot).hypothesisExec;



  let goal = input.goal;

  let { hypotheses, rejected } = await hypothesesFor(input, goal, human, exec);

  let refuted = hypotheses.filter(h => h.status === 'refuted');

  let replanned = false;



  const blocking = () => refuted.filter(h => !isModelId(h.id));



  // One chance to correct the goal when the run would stop: the model sees what the workspace refuted, and its answer

  // goes through the same checks. Never a second round.

  if (input.mode === 'enforce' && blocking().length > 0 && input.revise) {

    try {

      const missing = blocking().map(h => /^defined:(.+)$/.exec(h.probe)?.[1]).filter((n): n is string => !!n);

      const revised = (await input.revise({ goal, refuted: blocking(), similar: await similarNames(missing, input.workspaceRoot, input.files) })).trim();

      if (revised && revised !== goal) {

        const again = await hypothesesFor(input, revised, human, exec);

        replanned = true;

        goal = revised;

        hypotheses = again.hypotheses;

        rejected = [...rejected, ...again.rejected];

        refuted = hypotheses.filter(h => h.status === 'refuted');

      }

    } catch { /* keep the original verdict */ }

  }



  const blocked = input.mode === 'enforce' && blocking().length > 0;

  const lines = refuted.map(h => `- ${h.claim}: ${h.evidence}`);

  const summary = refuted.length === 0 ? '' : `${refuted.length} assumption${refuted.length === 1 ? '' : 's'} in the plan ${refuted.length === 1 ? 'is' : 'are'} refuted by the workspace:\n${lines.join('\n')}`;

  return { mode: input.mode, hypotheses, refuted, blocked, summary, goal, replanned, rejected };

}



/** Lines a person wrote around the table (notes, reminders) are not part of any row; they are carried over. */

async function readHumanNotes(file: string): Promise<string[]> {

  try {

    const md = await fs.readFile(file, 'utf-8');

    return md.split(/\r?\n/).filter(l => l.trim() !== '' && !l.startsWith('|') && !l.startsWith('#'));

  } catch {

    return [];

  }

}



/** Writes hypotheses.md next to tasks.md so a person (or the next resume) can read what was checked. */

export async function writeHypothesesFile(workspaceRoot: string, goal: string, list: Hypothesis[]): Promise<void> {

  if (list.length === 0) return;

  const file = path.join(workspaceRoot, HYPOTHESES_FILE);

  const notes = await readHumanNotes(file);

  const body = serializeHypothesesMarkdown(goal, list);

  await fs.writeFile(file, notes.length ? `${body}\n${notes.join('\n')}\n` : body, 'utf-8');

}
