import fs from 'node:fs/promises';
import path from 'node:path';
import { commandTargets, isTestFile } from './verify-guard.js';
import type { CodingAgentsInput } from './types.js';
import { writeContract } from './contract-writer.js';
import { extractCallSites, formatCallSites } from './call-sites.js';

/** A module the tests need many exports from is built one export per step (each step is syntax-gated and can be repaired alone). */
const MIN_NAMES = 2;
const MAX_NAMES = 10;

const stripExt = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/i, '');

/** Names the test files import from the target module, in order of first appearance. */
export function namesImportedFrom(testSource: string, testRel: string, targetRel: string): string[] {
  const wanted = stripExt(path.posix.normalize(targetRel.replace(/\\/g, '/')));
  const testDir = path.posix.dirname(testRel.replace(/\\/g, '/'));
  const hits: Array<{ spec: string; names: string }> = [];
  for (const m of testSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2/g)) hits.push({ names: m[1], spec: m[3] });
  for (const m of testSource.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)/g)) hits.push({ names: m[1], spec: m[3] });
  const names: string[] = [];
  for (const { spec, names: list } of hits) {
    if (!spec.startsWith('.')) continue;
    if (stripExt(path.posix.normalize(path.posix.join(testDir, spec))) !== wanted) continue;
    for (const part of list.split(',')) {
      // `a as b` / `a: b`: the exported name is the first
      const name = part.trim().split(/\s+as\s+|\s*:\s*/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Step goals for rebuilding a missing or empty module one export at a time, or [] when this does not apply
 * (explicit steps, several targets, an existing file, fewer than two imported names). Only the last step
 * runs the check (runSteps), and an earlier step that does not parse is rolled back by the pipeline's own gate.
 */
export async function deriveExportSteps(input: CodingAgentsInput): Promise<string[]> {
  if (!input.goal || !input.verifyCommand || input.targetFiles?.length !== 1) return [];
  const root = path.resolve(input.workspaceRoot || process.cwd());
  const target = input.targetFiles[0].replace(/\\/g, '/');
  try {
    const existing = await fs.readFile(path.resolve(root, target), 'utf8');
    if (existing.trim()) return [];
  } catch { /* a missing file is the case this is for */ }
  const names: string[] = [];
  const testSources: string[] = [];
  for (const testRel of commandTargets(input.verifyCommand).filter(isTestFile)) {
    try {
      const source = await fs.readFile(path.resolve(root, testRel), 'utf8');
      testSources.push(source);
      for (const n of namesImportedFrom(source, testRel, target)) if (!names.includes(n)) names.push(n);
    } catch { /* an unreadable test contributes nothing */ }
  }
  if (names.length < MIN_NAMES || names.length > MAX_NAMES) return [];
  // Always: the tests' own calls, copied literally (argument count, object vs array). No model, nothing to hallucinate.
  const sites = extractCallSites(testSources.join('\n'), names);
  const siteBlock = formatCallSites(sites);
  // Opt-in (contractModel): a larger local model adds return shapes and null/throw cases; bullets that contradict the calls are dropped.
  const written = await writeContract(input, root, target, names, undefined, sites);
  const block = [siteBlock, written.text].filter(Boolean).join('\n');
  const contractTail = block ? `${CONTRACT_MARK}${written.text ? ` (return shapes by ${input.contractModel}, checked against the calls)` : ''}]\n${block}` : '';
  return names.map((name, i) => {
    const others = names.filter(n => n !== name);
    const placement = i === 0
      ? 'Start the file with the imports it needs.'
      : 'Append it at the end of the file; leave everything already in the file unchanged.';
    // Wording matters to the hypothesis gate: it probes every backticked name as "must already exist" unless the goal
    // asks to create it ("implement `x`"). The names built in other steps are therefore written without backticks.
    return `${input.goal}\n\nStep ${i + 1} of ${names.length}: in ${target}, implement \`${name}\` now, completely. ${placement} The other exports of this module (${others.join(', ')}) are built in other steps: do not stub, rename or rewrite them.${contractTail}`;
  });
}

const CONTRACT_MARK = '\n\n[Contract read from the tests';
/** The contract block a step goal carries (empty when it has none). */
export const contractTailOf = (step: string): string => { const i = step.indexOf(CONTRACT_MARK); return i >= 0 ? step.slice(i) : ''; };

/** Does the module source already define and export `name` (ESM or CommonJS)? */
export function exportsName(source: string, name: string): boolean {
  const n = name.replace(/[$]/g, '\\$&');
  const esm = new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${n}\\b`);
  const esmList = new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`);
  const cjsObject = new RegExp(`module\\.exports\\s*=\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`);
  const cjsMember = new RegExp(`(?:module\\.)?exports\\.${n}\\s*=`);
  return esm.test(source) || esmList.test(source) || cjsObject.test(source) || cjsMember.test(source);
}

/** The name an export step builds (from its own wording), or undefined for any other goal. */
export function stepExportName(step: string): string | undefined {
  return step.match(/Step \d+ of \d+: in .+?, implement `([A-Za-z_$][\w$]*)` now/)?.[1];
}

/**
 * A model asked for one export of an empty file often writes the whole module in that call. Later steps for names
 * that already exist would then ask for a change that is already made (a SEARCH identical to its REPLACE), so they are
 * skipped; if the LAST step is already satisfied it becomes "make the check pass" so the check still runs and its
 * failures drive the repair.
 */
export function exportStepPreparer(input: CodingAgentsInput): (step: string, last: boolean) => Promise<string | null> {
  const root = path.resolve(input.workspaceRoot || process.cwd());
  const target = input.targetFiles?.[0];
  return async (step, last) => {
    const name = stepExportName(step);
    if (!name || !target) return step;
    let source = '';
    try { source = await fs.readFile(path.resolve(root, target), 'utf8'); } catch { return step; }
    if (!exportsName(source, name)) return step;
    return last
      ? `${input.goal}\n\nEvery export of ${target} already exists. Do not add them again: correct the existing code so the tests pass.${contractTailOf(step)}`
      : null;
  };
}
