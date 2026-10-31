/**
 * Reference-doc sync: the keys of a result or settings interface must appear in the reference doc that describes it.
 * New fields used to ship without a word in the docs because the pre-commit checks only compared tool inputs and
 * action names. Gaps that already exist are recorded in a baseline (it can only shrink); a NEW undocumented key fails.
 */
import { interfaceFields } from './input-sync.js';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keys of `interface typeName` (minus @internal ones) that the doc text never declares or quotes. */
export function findUndocumentedKeys(typeSrc: string, typeName: string, docText: string): string[] {
  const fields = interfaceFields(typeSrc, typeName);
  if (!fields) return [];
  return fields.fields
    .filter(k => !fields.internal.includes(k))
    .filter(k => !new RegExp(`(?:^|[^\\w$])["']?${esc(k)}["']?\\??\\s*[:=]|"${esc(k)}"`).test(docText));
}

export type DocGaps = Record<string, string[]>;

export function findNewDocGaps(current: DocGaps, baseline: DocGaps): string[] {
  const problems: string[] = [];
  for (const [type, keys] of Object.entries(current)) {
    const known = new Set(baseline[type] ?? []);
    for (const k of keys) if (!known.has(k)) problems.push(`${type}.${k} is not in its reference doc`);
  }
  return problems;
}

/** Baseline entries that are documented now: regenerate the baseline so it only shrinks. */
export function findClosedDocGaps(current: DocGaps, baseline: DocGaps): string[] {
  const closed: string[] = [];
  for (const [type, keys] of Object.entries(baseline)) {
    const now = new Set(current[type] ?? []);
    for (const k of keys) if (!now.has(k)) closed.push(`${type}.${k}`);
  }
  return closed;
}
