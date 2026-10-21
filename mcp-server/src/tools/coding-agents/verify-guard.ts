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
    if (isTestFile(p.filePath) && !isExecutableSurface(p.filePath, targets, false)) {
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
  exitCode: number | null;
  timedOut?: boolean;
  outputTail: string;
  patchedFiles: string[];
}

const KEY_LINE_RE = /\b(FAIL(ED)?|ERROR|AssertionError|Assertion failed|Traceback|panic:|expected|received|actual|TypeError|ReferenceError|SyntaxError|✗|×|not ok)\b|^\s*[✗×]|^\s*E\s{2,}/i;
const FRAME_RE = /[\w./\\-]+\.[a-z]{1,4}:\d+(:\d+)?/i;
const BRIEF_CAP = 2000;

/** Persona header kept short: a 7B model follows few, concrete rules. */
const PERSONA = [
  'You are acting as the DEBUGGER for an edit that made a check fail.',
  'Rules: fix the production code under test. Do not edit tests, scripts, configs or hooks. Do not run commands or tests; the user runs them. Reply with only the corrected edit.',
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
  if (i.timedOut) parts.push('The check timed out: the edit probably introduced a hang or an infinite loop.');
  if (key.length) parts.push('Failures:\n' + dedupe(key).slice(0, 12).join('\n'));
  if (frames.length) parts.push('Frames in your edit:\n' + dedupe(frames).slice(0, 6).join('\n'));
  if (!key.length && !frames.length && lines.length) parts.push('Output:\n' + collapseSimilarLines(lines, { head: 4, tail: 8 }).join('\n'));
  if (!lines.length && !i.timedOut) parts.push('The check printed nothing.');
  const text = parts.join('\n\n');
  return text.length > BRIEF_CAP ? `${text.slice(0, BRIEF_CAP)}\n... (brief truncated)` : text;
}

/** Appends a debugger brief to the goal for a retry. */
export function withFeedback(goal: string, feedback?: string): string {
  const f = (feedback ?? '').trim();
  return f ? `${goal}\n\n[Feedback from the previous attempt; correct the production code, do not touch tests]\n${f.slice(0, BRIEF_CAP)}` : goal;
}
