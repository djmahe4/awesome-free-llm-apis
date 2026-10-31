import path from 'node:path';
import fs from 'fs-extra';
import { collapseSimilarLines } from '../../utils/log-compaction.js';

/**
 * Trust boundary around verifyCommand.
 *
 * The check is the judge; the model must not be able to rewrite the judge, add a lenient one, or run
 * code of its own choosing as a side effect of "verification". Detecting every trick is not feasible,
 * so the rule is simple and conservative: if an edit touches anything the check could execute (tests,
 * scripts, toolchain config, hooks), creates a test, deletes a file, or ADDS a destructive or
 * process-spawning call, the check is NOT run automatically and the edit is withheld. The user reviews
 * the diff, runs the check themselves, and reports the output back (verifyReport).
 *
 * Two levels. Writing or changing TESTS is legitimate (test-first work) and is applied, but the agent
 * never executes tests it authored: the check is not auto-run and the user runs it. Scripts, toolchain
 * config, hooks, CI, deletions and destructive calls are withheld entirely.
 */

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(__tests__|tests?|specs?|e2e|integration)\//,
  /\.(test|spec)\.[a-z0-9]+$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.(go|py|rb|rs)$/,
  /(^|\/)(setup|globalsetup|setuptests|jest\.setup|vitest\.setup)\.[a-z]+$/,
];

const SURFACE_PATTERNS: RegExp[] = [
  // test runner / toolchain config
  /(^|\/)(vitest|vite|jest|mocha|playwright|karma|babel|webpack|rollup|tsup|eslint|tsconfig)(\.[a-z]+)?\.(config\.)?[a-z]+$/,
  /(^|\/)\.mocharc/,
  /(^|\/)(package\.json|pytest\.ini|conftest\.py|tox\.ini|setup\.cfg|setup\.py|pyproject\.toml|makefile|cargo\.toml|build\.rs|go\.mod|pom\.xml|build\.gradle(\.kts)?)$/,
  // hooks and CI
  /(^|\/)\.husky\//,
  /(^|\/)\.git\/hooks\//,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  // scripts
  /(^|\/)scripts?\//,
  /\.(sh|bash|zsh|bat|cmd|ps1)$/,
];

const DESTRUCTIVE_RE = /\b(rmSync|rmdirSync|unlinkSync|rimraf|shutil\.rmtree|os\.remove|os\.unlink|os\.system|child_process|execSync|spawnSync|Invoke-Expression|Remove-Item)\b|\bfs\.(rm|remove)\b|\bfse?\.remove\b|\bsubprocess\.|\brm\s+-[a-z]*r|\bdel\s+\/|\bspawn\(|shell:\s*true|\beval\(/i;

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** Paths named in the verify command (`node check.js`, `npx vitest run tests/a.test.ts`). */
export function commandTargets(command: string): string[] {
  return command.trim().split(/\s+/).slice(1)
    .filter(t => !t.startsWith('-') && (t.includes('.') || t.includes('/')))
    .map(norm);
}

/** True for test files and test helpers. */
export function isTestFile(relPath: string): boolean {
  const p = norm(relPath);
  return TEST_PATTERNS.some(re => re.test(p));
}

/** True for non-test files the check could execute or that hook the toolchain; tests count too when `includeTests`. */
export function isExecutableSurface(relPath: string, targets: string[] = [], includeTests = true): boolean {
  const p = norm(relPath);
  if (SURFACE_PATTERNS.some(re => re.test(p))) return true;
  if (includeTests && TEST_PATTERNS.some(re => re.test(p))) return true;
  return targets.some(t => p === t || p.endsWith(`/${t}`) || t.endsWith(`/${p}`));
}

export interface PatchFact {
  filePath: string;
  /** null for a file that did not exist before the edit. */
  before: string | null;
  after: string;
  isNew: boolean;
}

export interface VerifyAssessment {
  /** Withhold the edit: it touches scripts/config/hooks, deletes a file or adds a destructive call. */
  suspicious: boolean;
  reasons: string[];
  files: string[];
  /** The edit writes or changes tests: apply it, but do not auto-run the check; the user runs it. */
  manualRun: boolean;
  manualReasons: string[];
}

export function assessPatchesForVerify(patches: PatchFact[], command: string): VerifyAssessment {
  const targets = commandTargets(command);
  const reasons: string[] = [];
  const manualReasons: string[] = [];
  const files = new Set<string>();
  const flag = (file: string, why: string) => { files.add(file); reasons.push(`${file}: ${why}`); };

  for (const p of patches) {
    if (isTestFile(p.filePath)) {
      manualReasons.push(`${p.filePath}: ${p.isNew ? 'a test was created by the agent' : 'a test was changed by the agent'}; the agent does not run tests it wrote`);
    } else if (isExecutableSurface(p.filePath, targets, false)) {
      flag(p.filePath, p.isNew
        ? 'the edit would CREATE a script or toolchain file that the check can execute'
        : 'script, toolchain, hook or CI file that the check can execute');
    }
    if (!p.isNew && p.before && p.after.trim() === '') flag(p.filePath, 'the edit empties (deletes) the file');
    const beforeLines = new Set((p.before ?? '').split(/\r?\n/).map(l => l.trim()));
    const added = p.after.split(/\r?\n/).map(l => l.trim()).filter(l => l && !beforeLines.has(l));
    const hit = added.find(l => DESTRUCTIVE_RE.test(l));
    if (hit) flag(p.filePath, `adds a destructive or process-spawning call: ${hit.slice(0, 80)}`);
  }
  return { suspicious: reasons.length > 0, reasons, files: [...files], manualRun: manualReasons.length > 0, manualReasons };
}

export interface RepairBriefInput {
  command: string;
  /** Failing case names collected from the whole run (see runVerifyCommand). */
  failedCases?: string[];
  exitCode: number | null;
  timedOut?: boolean;
  outputTail: string;
  patchedFiles: string[];
  /** Current content of the edited files, for cheap static hints (e.g. a member read but never assigned). */
  fileContents?: Record<string, string>;
  /** Cases that already failed before this edit. With it, the brief separates what the edit broke from what was red already. */
  baselineFailedCases?: string[];
  /** Lines the edit removed with nothing equal in their place (see deletedLines). */
  deletedLines?: string[];
}

/** Test runners append a duration ("... 4ms", "(12 ms)"); it changes between runs, so it is not part of a case's identity. */
const caseKey = (c: string) => c.replace(/\s*\(?\d+(?:\.\d+)?\s*m?s\)?\s*$/, '').trim();

const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;

/**
 * Lines of `before` that do not appear in `after` (counted, so a line kept once out of two counts once), ignoring
 * blank and bracket-only lines. A small model asked to replace one loop also deleted the next one in three attempts
 * out of three, and nothing told it so (#109).
 */
export function deletedLines(before: string | null | undefined, after: string): string[] {
  if (!before) return [];
  const left = new Map<string, number>();
  for (const l of after.split(/\r?\n/)) { const t = l.trim(); left.set(t, (left.get(t) ?? 0) + 1); }
  const out: string[] = [];
  for (const l of before.split(/\r?\n/)) {
    const t = l.trim();
    if (TRIVIAL_LINE.test(t)) continue;
    const n = left.get(t) ?? 0;
    if (n > 0) left.set(t, n - 1);
    else out.push(t);
  }
  return out;
}

/**
 * Members a file reads as `this.x` but never assigns (`this.x =`, `+=`, ...), defines as a method
 * (`x(`) or class field (`x =`), or calls (`this.x(`). Traced: the 7B passed `this.currency` everywhere
 * but never stored it, so every price silently fell back to the default for the whole repair budget.
 */
export function unassignedMembers(content: string, filePath?: string): string[] {
  // Python uses self.x (assigned with self.x = / +=, methods are def x(...)); JS/TS, Java and C# use this.x.
  if (/\.py$/i.test(filePath ?? '')) {
    const reads = new Set<string>();
    for (const m of content.matchAll(/\bself\.([A-Za-z_]\w*)\b(?!\s*\()/g)) reads.add(m[1]);
    const defined = new Set<string>();
    for (const m of content.matchAll(/\bself\.([A-Za-z_]\w*)\s*(?:[-+*/%&|^@]|\/\/|\*\*|>>|<<)?=(?!=)/g)) defined.add(m[1]);
    for (const m of content.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm)) defined.add(m[1]);
    for (const m of content.matchAll(/^\s+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) defined.add(m[1]); // class attributes
    for (const m of content.matchAll(/^\s*@property\s*\n\s*def\s+([A-Za-z_]\w*)/gm)) defined.add(m[1]);
    return [...reads].filter(r => !defined.has(r));
  }
  const reads = new Set<string>();
  for (const m of content.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) reads.add(m[1]);
  const defined = new Set<string>();
  for (const m of content.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*(?:[-+*/%&|^]|\?\?|\|\||&&)?=(?!=)/g)) defined.add(m[1]);
  for (const m of content.matchAll(/^\s*(?:static\s+|async\s+|get\s+|set\s+|#)*([A-Za-z_$][\w$]*)\s*(?:\(|=(?!=)|;)/gm)) defined.add(m[1]);
  for (const m of content.matchAll(/[{;]\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) defined.add(m[1]); // inline class fields
  for (const m of content.matchAll(/\{\s*([^}]*)\}\s*=\s*this\b/g)) for (const n of m[1].split(',')) defined.add(n.trim().split(/\s|:/)[0]);
  return [...reads].filter(r => !defined.has(r));
}

/**
 * A call with the wrong number of arguments is the usual half-finished signature change. The runtime
 * message already says so, but a small model does not act on it, so the brief spells out the fix.
 * Python messages only (JS silently ignores extra arguments, so there is no runtime error to read).
 */
export function arityErrorHint(output: string): string | null {
  const tooMany = output.match(/([A-Za-z_][\w.]*)\(\) takes (?:from )?(\d+(?: to \d+)?) positional arguments? but (\d+) (?:was|were) given/);
  if (tooMany) {
    const [, fn, accepts, given] = tooMany;
    return `${fn} is called with ${given} arguments but its definition accepts ${accepts}: add the missing parameter to the definition of ${fn} (in the production code, not the test), then pass it through wherever it is used.`;
  }
  const keyword = output.match(/([A-Za-z_][\w.]*)\(\) got an unexpected keyword argument '(\w+)'/);
  if (keyword) {
    const [, fn, name] = keyword;
    return `${fn} is called with the keyword argument ${name} but does not accept it: add a parameter named ${name} to the definition of ${fn}.`;
  }
  return null;
}

const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'async', 'elif', 'except', 'with', 'assert', 'not', 'and', 'or', 'in', 'is', 'lambda', 'yield', 'del', 'raise',
  // builtins that legitimately take a varying number of arguments
  'print', 'super', 'range', 'min', 'max', 'round', 'format', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'open', 'getattr', 'setattr', 'require', 'import',
]);

/** Number of top-level arguments of the call whose "(" is at `open`, or null when it never closes. */
function countArgs(src: string, open: number): number | null {
  let depth = 0;
  let args = 0;
  let sawToken = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === '\\') i++;
      sawToken = true;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { if (depth > 0) sawToken = true; depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return sawToken ? args + 1 : 0;
      continue;
    }
    if (depth === 1) {
      if (c === ',') { args++; sawToken = true; continue; }
      if (!/\s/.test(c)) sawToken = true;
    }
  }
  return null;
}

/**
 * Functions called with different numbers of arguments in one file. Traced: the 7B added the new
 * `currency` argument to some calls of formatPrice and missed one. Method calls (`obj.m(`), declarations
 * (`function f(`, `def f(`, `name(...) {`) and a few variadic builtins are ignored; a function whose calls
 * simply use optional arguments can still show up, so callers phrase this as a hint.
 */
/**
 * Blanks out comments and the text of string literals (keeping newlines, so line numbers hold), but keeps
 * code inside template-literal `${...}` expressions: calls there are real, prose like "line(s)" is not.
 */
export function maskNonCode(src: string): string {
  const out: string[] = [];
  const templateDepths: number[] = []; // brace depth at which each open ${ started
  let braceDepth = 0;
  let i = 0;
  const blank = (c: string) => (c === '\n' ? '\n' : ' ');
  // stack of contexts: 'code' | 'template'
  const ctx: Array<'code' | 'template'> = ['code'];
  while (i < src.length) {
    const c = src[i];
    const top = ctx[ctx.length - 1];
    if (top === 'template') {
      if (c === '\\') { out.push(' ', blank(src[i + 1] ?? ' ')); i += 2; continue; }
      if (c === '`') { out.push(' '); ctx.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { out.push(' ', ' '); ctx.push('code'); templateDepths.push(braceDepth); braceDepth++; i += 2; continue; }
      out.push(blank(c)); i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { out.push(' '); i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i++) out.push(blank(src[i]));
      continue;
    }
    if (c === '"' || c === "'") {
      out.push(c); i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') { out.push(' '); i++; } out.push(blank(src[i] ?? ' ')); i++; }
      if (i < src.length && src[i] === c) { out.push(c); i++; }
      continue;
    }
    if (c === '`') { out.push(' '); ctx.push('template'); i++; continue; }
    if (c === '{') braceDepth++;
    if (c === '}') {
      braceDepth--;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === braceDepth) {
        templateDepths.pop(); ctx.pop(); out.push(' '); i++; continue; // back into the template text
      }
    }
    out.push(c); i++;
  }
  return out.join('');
}

export function inconsistentCalls(rawSrc: string): Array<{ name: string; counts: Array<{ args: number; lines: number[] }> }> {
  const src = maskNonCode(rawSrc);
  const byName = new Map<string, Map<number, number[]>>();
  const lineOf = (index: number) => src.slice(0, index).split('\n').length;
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (NOT_CALLS.has(name)) continue;
    const before = src.slice(Math.max(0, m.index! - 12), m.index!);
    if (/\b(function|def|class|fn|func|new)\s+$/.test(before) && !/\bnew\s+$/.test(before)) continue;
    const open = m.index! + m[0].length - 1;
    const n = countArgs(src, open);
    if (n === null) continue;
    // "name(args) {" is a method declaration
    let close = open, depth = 0;
    for (; close < src.length; close++) {
      if (src[close] === '(') depth++;
      else if (src[close] === ')' && --depth === 0) break;
    }
    if (/^\s*\{/.test(src.slice(close + 1, close + 40))) continue;
    const counts = byName.get(name) ?? new Map<number, number[]>();
    counts.set(n, [...(counts.get(n) ?? []), lineOf(m.index!)]);
    byName.set(name, counts);
  }
  return [...byName.entries()]
    .filter(([, c]) => c.size > 1)
    .map(([name, c]) => ({ name, counts: [...c.entries()].sort((a, b) => a[0] - b[0]).map(([args, lines]) => ({ args, lines })) }));
}

const KEY_LINE_RE =/\b(FAIL(ED)?|ERROR|AssertionError|Assertion failed|Traceback|panic:|expected|received|actual|TypeError|ReferenceError|SyntaxError|✗|×|not ok)\b|^\s*[✗×]|^\s*E\s{2,}/i;
const FRAME_RE = /[\w./\\-]+\.[a-z]{1,4}:\d+(:\d+)?/i;
const BRIEF_CAP = 2000;

/** Quoted strings and ip/number-like tokens in failing case names: the inputs the tests use. */
function caseInputs(cases: string[]): string[] {
  const out = new Set<string>();
  for (const c of cases) {
    for (const m of c.matchAll(/"([^"]{3,})"|'([^']{3,})'/g)) out.add(m[1] ?? m[2]);
    for (const m of c.matchAll(/\b\d[\w.:-]*\d\b/g)) if (m[0].length >= 3) out.add(m[0]);
  }
  return [...out];
}

/**
 * A small model that cannot find the general bug adds the failing input as a literal (`if (x === "1.5h")`
 * or a regex of it). Returns the failing inputs that appear in the newly added lines.
 */
export function detectSpecialCasing(addedLines: string[], failedCases: string[]): string[] {
  const text = addedLines.join('\n').replace(/\\/g, '');
  return caseInputs(failedCases).filter(lit => lit.length >= 3 && text.includes(lit));
}

/** Persona header kept short: a 7B model follows few, concrete rules. */
const PERSONA = [
  'You are acting as the DEBUGGER for an edit that made a check fail.',
  'Rules: fix the production code under test. Do not edit tests, scripts, configs or hooks. Do not run commands or tests; the user runs them. Reply with only the corrected edit.',
  'Check boundary values, and compare numbers as numbers (not as strings). Fix the general logic; never special-case a test input.',
].join('\n');

/**
 * Turns a failing run's output into the input for the next attempt: failing test names and assertion
 * lines, stack frames that point into the patched files, then a compacted remainder (the shared
 * log-compaction helper collapses repeated lines). Bounded to ~2 KB.
 */
export function buildRepairBrief(i: RepairBriefInput): string {
  const lines = (i.outputTail || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean);
  const patchedBase = i.patchedFiles.map(f => norm(f).split('/').pop()!);
  const key: string[] = [];
  const frames: string[] = [];
  for (const l of lines) {
    if (KEY_LINE_RE.test(l)) key.push(l.trim());
    if (FRAME_RE.test(l) && patchedBase.some(b => norm(l).includes(b))) frames.push(l.trim());
  }
  const dedupe = (a: string[]) => [...new Set(a)];
  const parts: string[] = [PERSONA, `Check: ${i.command} (${i.timedOut ? 'timed out' : `exit ${i.exitCode}`})`];
  const cases = i.failedCases ?? [];
  const list = (a: string[]) => `${a.slice(0, 15).join('\n')}${a.length > 15 ? `\n(+${a.length - 15} more)` : ''}`;
  if (cases.length && i.baselineFailedCases) {
    // What the edit broke comes first: those tests passed a moment ago, so the edit itself is the cause.
    const before = new Set(i.baselineFailedCases.map(caseKey));
    const broke = cases.filter(c => !before.has(caseKey(c)));
    const still = cases.filter(c => before.has(caseKey(c)));
    if (broke.length) parts.push(`Your edit broke ${broke.length === 1 ? 'this test, which' : `these ${broke.length} tests, which`} passed before it. Fix ${broke.length === 1 ? 'it' : 'them'} first; usually the edit removed or changed code ${broke.length === 1 ? 'it relies' : 'they rely'} on:\n${list(broke)}`);
    if (still.length) parts.push(`Still failing, as before the edit (${still.length}):\n${list(still)}`);
  } else if (cases.length) {
    parts.push(`Failing cases (${cases.length}):\n${list(cases)}`);
  }
  if (i.deletedLines && i.deletedLines.length) {
    parts.push(`Your edit deleted these lines and nothing in it replaces them. If the goal did not ask for that, keep them:\n${i.deletedLines.slice(0, 15).join('\n')}`);
  }
  if (/Missing expected exception|did not throw|expected .* to throw/i.test(i.outputTail)) {
    parts.push('A call that should have thrown returned normally: the current logic ACCEPTS that input. Find the part that accepts it (a regex or condition that is too permissive) and tighten that. Do not add a special case for the input.');
  }
  if (/expected -?[\d.]+ to (be|equal) [+-]?[\d.]+/i.test(i.outputTail)) {
    parts.push('A number is wrong: re-check what the functions you call return (an array, its length and a cursor/index are different things) and read their definitions before changing arithmetic.');
  }
  for (const [file, content] of Object.entries(i.fileContents ?? {})) {
    const missing = unassignedMembers(content, file);
    if (missing.length > 0) {
      const py = /\.py$/i.test(file);
      parts.push(`${file} reads ${missing.map(m => `${py ? 'self' : 'this'}.${m}`).join(', ')} but never assigns ${missing.length > 1 ? 'them' : 'it'}, so ${missing.length > 1 ? 'they are' : 'it is'} never set: store the value (for example in ${py ? '__init__' : 'the constructor'}) before using it.`);
    }
  }
  const arity = arityErrorHint(i.outputTail || '');
  if (arity) parts.push(arity);
  for (const [file, content] of Object.entries(i.fileContents ?? {})) {
    for (const call of inconsistentCalls(content).slice(0, 2)) {
      const describe = (c: { args: number; lines: number[] }) => `${c.args} argument${c.args === 1 ? '' : 's'} on line${c.lines.length > 1 ? 's' : ''} ${c.lines.join(', ')}`;
      parts.push(`${file} calls ${call.name} with ${call.counts.map(describe).join(' but ')}: if the edit added or renamed a parameter, update every call of ${call.name} the same way.`);
    }
  }
  if (cases.length > 3) parts.push('Several cases fail: rewrite the whole function from the requirements instead of patching single lines.');
  if (i.timedOut) parts.push('The check timed out: the edit probably introduced a hang or an infinite loop.');
  if (key.length) parts.push('Failures:\n' + dedupe(key).slice(0, 12).join('\n'));
  if (frames.length) parts.push('Frames in your edit:\n' + dedupe(frames).slice(0, 6).join('\n'));
  if (!key.length && !frames.length && lines.length) parts.push('Output:\n' + collapseSimilarLines(lines, { head: 4, tail: 8 }).join('\n'));
  if (!lines.length && !i.timedOut) parts.push('The check printed nothing.');
  const text = parts.join('\n\n');
  return text.length > BRIEF_CAP ? `${text.slice(0, BRIEF_CAP)}\n... (brief truncated)` : text;
}

const TEST_CTX_PER_FILE = 5000;
const TEST_CTX_TOTAL = 6500;

/**
 * The tests a verifyCommand runs are the specification. The agent may READ them (never edit or run
 * them): without them it only has the prose goal and cannot know that, say, "1.5h" must be rejected.
 * Only test files named in the command, inside the workspace, are included; bounded.
 */
export async function readVerifyTestContext(command: string, workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const blocks: string[] = [];
  let used = 0;
  for (const target of commandTargets(command)) {
    if (!isTestFile(target)) continue;
    const abs = path.resolve(root, target);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue; // never leave the workspace
    let text: string;
    try { text = await fs.readFile(abs, 'utf-8'); } catch { continue; }
    const room = Math.min(TEST_CTX_PER_FILE, TEST_CTX_TOTAL - used);
    if (room <= 0) break;
    const clipped = text.length > room ? `${text.slice(0, room)}\n... (truncated)` : text;
    used += clipped.length;
    blocks.push(`--- ${target} ---\n${clipped}`);
  }
  return blocks.length
    ? `[Tests that must pass: read-only specification. Do not edit, delete or run them; make the production code satisfy them.]\n${blocks.join('\n')}`
    : '';
}

/**
 * Brief for an edit that was rolled back because it does not parse. OpenCode feeds LSP errors back
 * after every edit; the pipeline already computes these diagnostics, they just never reached the retry.
 */
export function buildSyntaxBrief(diagnostics: Array<{ filePath: string; line?: number; message: string; severity?: string }>): string {
  const errors = diagnostics.filter(d => d.severity === 'error');
  if (errors.length === 0) return '';
  const shown = errors.slice(0, 10).map(d => `${d.filePath}${d.line ? `:${d.line}` : ''} ${d.message.split('\n')[0].slice(0, 200)}`);
  const more = errors.length > shown.length ? `\n(+${errors.length - shown.length} more)` : '';
  return [
    'Your last edit was rolled back: the file does not parse (syntax errors).',
    `Errors:\n${shown.join('\n')}${more}`,
    'Rules: return a corrected edit that is valid code. Do not run commands or tests; the user runs them.',
  ].join('\n');
}

/** Appends a debugger brief to the goal for a retry. */
export function withFeedback(goal: string, feedback?: string): string {
  const f = (feedback ?? '').trim();
  return f ? `${goal}\n\n[Feedback from the previous attempt; correct the production code, do not touch tests]\n${f.slice(0, BRIEF_CAP)}` : goal;
}
